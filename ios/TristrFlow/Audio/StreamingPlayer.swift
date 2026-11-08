import AVFoundation

/// Plays PCM that is still arriving, and can jump anywhere in what has arrived.
///
/// Every received sample is kept as Int16 (half the memory of Float), so a seek
/// is just "stop, then schedule again from sample N". Only a few seconds are ever
/// scheduled ahead, and each consumed slice schedules the next, so playback keeps
/// going with the screen locked, where a display link would stop firing.
@MainActor
final class StreamingPlayer {
    let sampleRate: Double

    private let engine = AVAudioEngine()
    private let node = AVAudioPlayerNode()
    private let timePitch = AVAudioUnitTimePitch()
    private let format: AVAudioFormat

    private(set) var samples: [Int16] = []
    private(set) var isPlaying = false

    private var baseOffset = 0     // content sample at the node's time zero
    private var scheduledUpTo = 0  // content handed to the node so far
    private var pausedAt = 0       // content position while stopped
    private var lastPosition = 0
    private var generation = 0     // invalidates completion callbacks from an earlier schedule

    private let window: Int        // how far ahead of the playhead to keep scheduled
    private let slice: Int         // samples per scheduled buffer

    /// Playback speed, pitch preserved.
    var rate: Float = 1 {
        didSet { timePitch.rate = rate }
    }

    init(sampleRate: Double = 24_000) {
        self.sampleRate = sampleRate
        format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: sampleRate, channels: 1, interleaved: false)!
        window = Int(sampleRate * 6)
        slice = Int(sampleRate)

        engine.attach(node)
        engine.attach(timePitch)
        engine.connect(node, to: timePitch, format: format)
        engine.connect(timePitch, to: engine.mainMixerNode, format: format)

        NotificationCenter.default.addObserver(
            forName: .AVAudioEngineConfigurationChange, object: engine, queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated { self?.recoverAfterRouteChange() }
        }
    }

    // MARK: - Position

    var receivedDuration: Double { Double(samples.count) / sampleRate }
    var currentTime: Double { Double(currentSample) / sampleRate }

    /// What the listener is hearing, in content samples.
    var currentSample: Int {
        guard isPlaying else { return pausedAt }
        guard let raw = nodeSampleTime() else { return lastPosition }
        let heard = baseOffset + raw - latencySamples
        let position = min(max(heard, baseOffset), scheduledUpTo)
        lastPosition = position
        return position
    }

    /// True when playback is waiting for more audio from the network.
    var isStarved: Bool {
        guard isPlaying, let raw = nodeSampleTime() else { return false }
        return baseOffset + raw >= samples.count
    }

    private func nodeSampleTime() -> Int? {
        guard let renderTime = node.lastRenderTime,
              let playerTime = node.playerTime(forNodeTime: renderTime) else { return nil }
        return Int(playerTime.sampleTime)
    }

    /// The node renders ahead of what reaches the ear. The output buffer, the
    /// time-pitch unit's look-ahead, and Bluetooth (around 0.2 s on AirPods).
    /// Without this the highlight would run ahead of the voice.
    private var latencySamples: Int {
        Int(outputLatency * sampleRate * Double(rate))
    }

    /// Seconds between the node rendering a sample and the listener hearing it.
    var outputLatency: Double {
        let session = AVAudioSession.sharedInstance()
        return session.outputLatency + session.ioBufferDuration + timePitch.latency
    }

    // MARK: - Feeding

    func append(_ chunk: [Int16]) {
        guard !chunk.isEmpty else { return }
        samples.append(contentsOf: chunk)
        pump()
    }

    /// Keeps `window` samples scheduled ahead of the playhead.
    func pump() {
        guard isPlaying else { return }
        let raw = nodeSampleTime() ?? 0
        // Ran dry waiting on the network: the node's clock kept running through the
        // silence, so re-anchor it. The next slice starts playing immediately.
        if baseOffset + raw > scheduledUpTo { baseOffset = scheduledUpTo - raw }
        let playhead = baseOffset + raw
        while scheduledUpTo < samples.count, scheduledUpTo - playhead < window {
            let end = min(samples.count, scheduledUpTo + slice)
            schedule(scheduledUpTo, end)
            scheduledUpTo = end
        }
    }

    private func schedule(_ start: Int, _ end: Int) {
        let frames = end - start
        guard frames > 0,
              let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(frames)) else { return }
        buffer.frameLength = AVAudioFrameCount(frames)
        let out = buffer.floatChannelData![0]
        samples.withUnsafeBufferPointer { src in
            for i in 0..<frames { out[i] = Float(src[start + i]) / 32_768 }
        }
        let token = generation
        node.scheduleBuffer(buffer, completionCallbackType: .dataConsumed) { [weak self] _ in
            Task { @MainActor [weak self] in
                guard let self, self.generation == token else { return }
                self.pump()
            }
        }
    }

    // MARK: - Transport

    func play() {
        guard !isPlaying else { return }
        do {
            try activate()
        } catch {
            log.error("audio engine failed to start: \(error.localizedDescription, privacy: .public)")
            return
        }
        generation += 1
        node.stop()
        baseOffset = pausedAt
        scheduledUpTo = pausedAt
        lastPosition = pausedAt
        isPlaying = true
        pump()
        node.play()
    }

    func pause() {
        guard isPlaying else { return }
        pausedAt = currentSample
        isPlaying = false
        generation += 1
        node.stop()
        engine.pause()
    }

    func seek(toSeconds seconds: Double) {
        let target = max(0, min(samples.count, Int(seconds * sampleRate)))
        pausedAt = target
        lastPosition = target
        guard isPlaying else { return }
        isPlaying = false
        generation += 1
        node.stop()
        play()
    }

    /// Back to empty, ready for the next read.
    func reset() {
        generation += 1
        node.stop()
        if engine.isRunning { engine.pause() }
        isPlaying = false
        samples = []
        baseOffset = 0
        scheduledUpTo = 0
        pausedAt = 0
        lastPosition = 0
    }

    /// Hands the audio route back so music the user paused can resume.
    func deactivateSession() {
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    private func activate() throws {
        let session = AVAudioSession.sharedInstance()
        // .playback keeps reading with the ring/silent switch on and the screen locked.
        try session.setCategory(.playback, mode: .spokenAudio)
        try session.setActive(true)
        if !engine.isRunning {
            engine.prepare()
            try engine.start()
        }
    }

    /// The engine stops itself when the output route changes (AirPods connect, a
    /// call ends). Pick up exactly where the listener was.
    private func recoverAfterRouteChange() {
        guard isPlaying else { return }
        let position = lastPosition
        isPlaying = false
        generation += 1
        pausedAt = position
        play()
    }
}
