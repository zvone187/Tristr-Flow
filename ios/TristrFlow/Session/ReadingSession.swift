import AVFoundation
import Foundation
import Observation

/// One read-aloud: streams audio from the account service, plays it as it arrives,
/// tracks which word is being spoken, and seeks when a word is tapped.
@MainActor
@Observable
final class ReadingSession {
    enum Phase: Equatable {
        case idle        // nothing loaded: the compose screen
        case preparing   // waiting for the first audio
        case playing
        case paused
        case finished
        case failed(String)
    }

    private(set) var phase: Phase = .idle
    private(set) var timeline: Timeline?
    private(set) var currentWord: Int?
    /// Words whose audio exists; the reader dims the rest, like the desktop app.
    private(set) var generatedWords = 0
    private(set) var currentTime: Double = 0
    /// Audio received so far, final once `isComplete`.
    private(set) var duration: Double = 0
    private(set) var isComplete = false
    private(set) var isBuffering = false
    /// A short-lived status line ("Not generated yet…").
    private(set) var notice: String?
    /// Bumped whenever the reader should snap back to following the voice.
    private(set) var followToken = 0

    var speed: Double = 1 {
        didSet { player.rate = Float(speed) }
    }

    @ObservationIgnored private var player = StreamingPlayer()
    @ObservationIgnored private let client: ServiceClient
    @ObservationIgnored private let analytics: any ProductTracking
    @ObservationIgnored private let nowPlaying = NowPlaying()
    @ObservationIgnored private var streamTask: Task<Void, Never>?
    @ObservationIgnored private var noticeTask: Task<Void, Never>?
    // A Timer, not a display link: display links stop when the screen locks,
    // and background reading should keep the lock screen's progress current.
    @ObservationIgnored private var ticker: Timer?
    @ObservationIgnored private var started = false
    @ObservationIgnored private var hasPlayed = false
    @ObservationIgnored private var completedPlayback = false
    @ObservationIgnored private var partialRead = false
    @ObservationIgnored private var run = 0
    @ObservationIgnored private var lastNowPlaying: Double = -10
    @ObservationIgnored private var drainDeadline: Date?

    /// Audio buffered before playback starts, so the first syllable isn't clipped.
    private static let preroll = 0.25

    init(client: ServiceClient = ServiceClient(), analytics: (any ProductTracking)? = nil) {
        self.client = client
        self.analytics = analytics ?? ProductAnalytics.shared
        nowPlaying.onPlay = { [weak self] in self?.resume() }
        nowPlaying.onPause = { [weak self] in self?.pause() }
        nowPlaying.onToggle = { [weak self] in self?.togglePlay() }

        let center = NotificationCenter.default
        center.addObserver(forName: AVAudioSession.interruptionNotification, object: nil, queue: .main) { [weak self] note in
            guard let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
                  AVAudioSession.InterruptionType(rawValue: raw) == .began else { return }
            MainActor.assumeIsolated { self?.pause() } // a call or Siri took the audio
        }
        center.addObserver(forName: AVAudioSession.routeChangeNotification, object: nil, queue: .main) { [weak self] note in
            guard let raw = note.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt,
                  AVAudioSession.RouteChangeReason(rawValue: raw) == .oldDeviceUnavailable else { return }
            MainActor.assumeIsolated { self?.pause() } // headphones pulled out: don't start talking out loud
        }
    }

    var isActive: Bool { phase != .idle }
    var text: String { timeline?.text ?? "" }

    // MARK: - Starting and stopping

    func start(text: String, settings: AppSettings, token: String, onUnauthorized: @escaping (String) -> Void) {
        start(text: text,
              request: SpeechRequest(text: "", voiceID: settings.voiceID, stability: settings.stability, token: token),
              voiceName: settings.voiceName,
              speed: settings.speed,
              onUnauthorized: onUnauthorized)
    }

    func start(text raw: String, request base: SpeechRequest, voiceName: String, speed: Double,
               onUnauthorized: @escaping (String) -> Void = { _ in }) {
        let text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        analytics.capture(.readRequested(characterCount: text.utf16.count))
        guard !text.isEmpty else {
            analytics.capture(.readRejected)
            return
        }
        if isActive { stop() }
        run += 1
        let thisRun = run

        player.reset()
        if player.sampleRate != base.format.sampleRate {
            player = StreamingPlayer(sampleRate: base.format.sampleRate) // decoded audio arrives at the format's rate
        }
        self.speed = speed
        let timeline = Timeline(text: text)
        self.timeline = timeline
        currentWord = nil
        generatedWords = 0
        currentTime = 0
        duration = 0
        isComplete = false
        isBuffering = false
        notice = nil
        started = false
        hasPlayed = false
        completedPlayback = false
        partialRead = false
        drainDeadline = nil
        phase = .preparing
        startTicker()

        let segments = TextSegmenter.segments(of: text)
        analytics.capture(.readingStarted(segmentCount: segments.count))
        nowPlaying.begin(title: String(text.prefix(60)), artist: voiceName)
        log.info("read \(text.utf16.count) chars in \(segments.count) request(s)")

        streamTask = Task { [weak self] in
            await self?.stream(segments, of: text as NSString, base: base, run: thisRun, onUnauthorized: onUnauthorized)
        }
    }

    /// Back to the compose screen.
    func stop() {
        switch phase {
        case .preparing, .playing, .paused: analytics.capture(.readingStopped)
        default: break
        }
        clearRead()
    }

    private func clearRead() {
        cancelStream()
        noticeTask?.cancel()
        run += 1
        player.reset()
        player.deactivateSession()
        stopTicker()
        timeline = nil
        phase = .idle
        currentWord = nil
        generatedWords = 0
        currentTime = 0
        duration = 0
        isComplete = false
        isBuffering = false
        notice = nil
        nowPlaying.clear()
    }

    private func cancelStream() {
        streamTask?.cancel()
        streamTask = nil
    }

    // MARK: - Streaming

    private func stream(_ segments: [NSRange], of text: NSString, base: SpeechRequest, run thisRun: Int,
                        onUnauthorized: (String) -> Void) async {
        let began = Date()
        var firstAudio = true
        do {
            for segment in segments {
                guard thisRun == run, let timeline else { return }
                // The service trims each request. Skip blank chunks and start the
                // alignment at the first character the service will actually read.
                let first = text.rangeOfCharacter(from: .whitespacesAndNewlines.inverted,
                                                  options: [], range: segment)
                guard first.location != NSNotFound else { continue }
                timeline.beginSegment(at: first.location)
                // Exact: this request's audio begins after every sample received so far.
                let offset = player.receivedDuration
                var request = base
                request.text = text.substring(with: segment)

                for try await chunk in client.stream(request) {
                    guard thisRun == run else { return }
                    if firstAudio, !chunk.samples.isEmpty {
                        firstAudio = false
                        log.info("first audio after \(Date().timeIntervalSince(began), format: .fixed(precision: 2))s")
                    }
                    receive(chunk, timeOffset: offset)
                }
            }
            guard thisRun == run else { return }
            analytics.capture(.synthesisCompleted)
            isComplete = true
            duration = player.receivedDuration
            if !started { beginPlayback() } // the whole thing was shorter than the pre-roll
            log.info("stream complete: \(self.duration, format: .fixed(precision: 2))s of audio in \(Date().timeIntervalSince(began), format: .fixed(precision: 2))s")
        } catch {
            guard thisRun == run, !Task.isCancelled, (error as? URLError)?.code != .cancelled else { return }
            partialRead = player.receivedDuration > 0
            analytics.capture(.readingFailed(Self.failureReason(error), partial: partialRead))
            if let serviceError = error as? ServiceError, case .unauthorized = serviceError {
                clearRead()
                onUnauthorized(base.token)
            } else {
                fail(error)
            }
        }
    }

    private static func failureReason(_ error: Error) -> ProductEvent.FailureReason {
        switch error {
        case ServiceError.unauthorized, ServiceError.invalidCredentials: return .unauthorized
        case ServiceError.insufficientCredits: return .credits
        case ServiceError.undecodableAudio: return .audio
        case is ServiceError: return .service
        case is URLError: return .network
        default: return .unknown
        }
    }

    private func receive(_ chunk: SpeechChunk, timeOffset: Double) {
        if !chunk.samples.isEmpty { player.append(chunk.samples) }
        if let alignment = chunk.alignment, let timeline {
            timeline.apply(alignment, timeOffset: timeOffset)
            if generatedWords != timeline.generatedWordCount { generatedWords = timeline.generatedWordCount }
        }
        duration = player.receivedDuration
        if !started, player.receivedDuration >= Self.preroll { beginPlayback() }
    }

    private func beginPlayback() {
        started = true
        guard phase == .preparing else { return } // paused before the audio arrived
        play()
    }

    private func fail(_ error: Error) {
        let message = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        log.error("The speech request failed")
        if player.receivedDuration > 0 {
            // A later request failed: keep what already arrived playable, and say why it ends early.
            isComplete = true
            duration = player.receivedDuration
            if !started { beginPlayback() }
            flash("Stopped early. \(message)", seconds: 6)
        } else {
            player.reset()
            stopTicker()
            phase = .failed(message)
        }
    }

    // MARK: - Transport

    func togglePlay() {
        switch phase {
        case .playing: pause()
        case .paused: resume()
        case .finished: resume()
        case .preparing:
            // Paused before any audio: hold at the start instead of auto-playing.
            started = true
            phase = .paused
            analytics.capture(.playbackChanged(.paused))
        default: break
        }
    }

    func pause() {
        guard phase == .playing else { return }
        player.pause()
        phase = .paused
        analytics.capture(.playbackChanged(.paused))
        isBuffering = false
        currentTime = player.currentTime
        updateNowPlaying(force: true)
    }

    func resume() {
        guard phase == .paused || phase == .finished else { return }
        guard player.receivedDuration > 0 else {
            started = false // nothing to play yet, start at the pre-roll
            phase = .preparing
            return
        }
        if phase == .finished { player.seek(toSeconds: 0) }
        play()
    }

    /// Tap-to-seek: jump to a word and keep reading from it.
    func seek(toWord word: Int) {
        guard let timeline else { return }
        guard let start = timeline.startTime(ofWord: word), start < player.receivedDuration - 0.05 else {
            flash("Not generated yet…")
            return
        }
        player.seek(toSeconds: start)
        analytics.capture(.seek)
        currentTime = start
        currentWord = word
        followToken += 1
        if phase != .playing {
            started = true
            play()
        } else {
            updateNowPlaying(force: true)
        }
        log.info("seek to word \(word) at \(start, format: .fixed(precision: 2))s")
    }

    /// Starts the player and reports what actually happened: the engine can
    /// refuse to start (mid phone call, say), and claiming .playing then would
    /// leave the screen showing a read that isn't making a sound.
    private func play() {
        let previous = phase
        player.play()
        phase = player.isPlaying ? .playing : .paused
        if player.isPlaying {
            if !hasPlayed {
                hasPlayed = true
                analytics.capture(.playbackStarted)
            } else if previous != .playing {
                analytics.capture(.playbackChanged(.playing))
                if previous == .finished { analytics.capture(.replay) }
            }
            startTicker()
        }
        updateNowPlaying(force: true)
    }

    func setSpeed(_ value: Double) {
        speed = value
        updateNowPlaying(force: true)
    }

    // MARK: - Clock

    private func startTicker() {
        guard ticker == nil else { return }
        let timer = Timer(timeInterval: 1.0 / 30, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.tick() }
        }
        RunLoop.main.add(timer, forMode: .common) // keep updating while the text is being scrolled
        ticker = timer
    }

    private func stopTicker() {
        ticker?.invalidate()
        ticker = nil
    }

    private func tick() {
        guard let timeline else { return }
        player.pump()
        let t = player.currentTime
        if abs(t - currentTime) >= 0.01 { currentTime = t }
        let word = timeline.wordIndex(at: t)
        if word != currentWord { currentWord = word }

        let buffering = phase == .playing && !isComplete && player.isStarved
        if buffering != isBuffering { isBuffering = buffering }

        // Finished = the node has rendered every sample, plus the time those last
        // samples take to reach the ear. Stopping at "rendered" would clip the
        // final word; waiting for the compensated position to reach the end would
        // hang if the node's clock stops once it runs out of audio.
        if phase == .playing, isComplete, player.isStarved {
            if drainDeadline == nil {
                drainDeadline = Date().addingTimeInterval(player.outputLatency + 0.15)
            } else if let deadline = drainDeadline, Date() >= deadline {
                finish()
                return
            }
        } else {
            drainDeadline = nil
        }
        if abs(currentTime - lastNowPlaying) >= 1 { updateNowPlaying() }
    }

    private func finish() {
        drainDeadline = nil
        player.pause()
        phase = .finished
        if !partialRead, !completedPlayback {
            completedPlayback = true
            analytics.capture(.playbackCompleted)
        }
        currentWord = nil
        currentTime = duration
        stopTicker()
        player.deactivateSession()
        updateNowPlaying(force: true)
        log.info("finished")
    }

    private func flash(_ message: String, seconds: Double = 1.6) {
        notice = message
        noticeTask?.cancel()
        noticeTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(seconds))
            guard !Task.isCancelled else { return }
            self?.notice = nil
        }
    }

    private func updateNowPlaying(force: Bool = false) {
        guard force || abs(currentTime - lastNowPlaying) >= 1 else { return }
        lastNowPlaying = currentTime
        nowPlaying.update(elapsed: currentTime, duration: duration, rate: speed, playing: phase == .playing)
    }
}
