import XCTest
@testable import TristrFlow

/// Emits the service's NDJSON protocol with a controlled amount of PCM and
/// timing per character, so playback duration and word offsets are predictable.
final class FakeSpeechService: URLProtocol {
    struct Behavior {
        var status = 200
        var secondRequestStatus: Int?
        var lineDelay: TimeInterval = 0
        var secondsPerChar = 0.05
    }

    static var behavior = Behavior()
    static var requests: [String] = []
    private var stopped = false

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let behavior = Self.behavior
        let text = Self.text(of: request)
        Self.requests.append(text)
        let status = Self.requests.count == 2 ? (behavior.secondRequestStatus ?? behavior.status) : behavior.status
        let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: "HTTP/1.1", headerFields: nil)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        let body: [Data]
        switch status {
        case 200:
            body = Self.lines(for: text.trimmingCharacters(in: .whitespacesAndNewlines),
                              secondsPerChar: behavior.secondsPerChar)
        case 401: body = [Data(#"{"error":"not_authenticated"}"#.utf8)]
        case 402: body = [Data(#"{"error":"insufficient_credits"}"#.utf8)]
        default: body = [Data(#"{"error":"unavailable"}"#.utf8)]
        }
        DispatchQueue.global().async {
            for line in body {
                if behavior.lineDelay > 0 { Thread.sleep(forTimeInterval: behavior.lineDelay) }
                if self.stopped { return }
                self.client?.urlProtocol(self, didLoad: line)
            }
            self.client?.urlProtocolDidFinishLoading(self)
        }
    }

    override func stopLoading() { stopped = true }

    private static func text(of request: URLRequest) -> String {
        var data = request.httpBody ?? Data()
        if data.isEmpty, let stream = request.httpBodyStream {
            stream.open()
            defer { stream.close() }
            var buffer = [UInt8](repeating: 0, count: 4096)
            while stream.hasBytesAvailable {
                let n = stream.read(&buffer, maxLength: buffer.count)
                if n <= 0 { break }
                data.append(buffer, count: n)
            }
        }
        return ((try? JSONSerialization.jsonObject(with: data)) as? [String: Any])?["text"] as? String ?? ""
    }

    static func lines(for text: String, secondsPerChar: Double, pieces: Int = 4) -> [Data] {
        let chars = text.unicodeScalars.map(String.init)
        let per = max(1, Int((Double(chars.count) / Double(pieces)).rounded(.up)))
        var out = [Data("{\"type\":\"segment\",\"index\":0}\n".utf8)]
        var i = 0
        while i < chars.count {
            let r = i..<min(i + per, chars.count)
            let starts = r.map { Double($0) * secondsPerChar }
            let samples = Int((Double(r.count) * secondsPerChar * 24_000).rounded())
            let line: [String: Any] = [
                "audio": Data(count: samples * 2).base64EncodedString(),
                "alignment": [
                    "characters": Array(chars[r]),
                    "character_start_times_seconds": starts,
                    "character_end_times_seconds": starts.map { $0 + secondsPerChar },
                ],
            ]
            out.append(try! JSONSerialization.data(withJSONObject: line) + Data("\n".utf8))
            i = r.upperBound
        }
        out.append(Data("{\"type\":\"done\"}\n".utf8))
        return out
    }
}

@MainActor
final class ReadingSessionTests: XCTestCase {
    private final class Spy: ProductTracking {
        var events: [ProductEvent] = []
        func capture(_ event: ProductEvent) { events.append(event) }
    }

    private var session: ReadingSession!
    private var analytics: Spy!

    override func setUp() async throws {
        FakeSpeechService.behavior = .init()
        FakeSpeechService.requests = []
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [FakeSpeechService.self]
        analytics = Spy()
        session = ReadingSession(client: ServiceClient(session: URLSession(configuration: config)), analytics: analytics)
    }

    override func tearDown() async throws {
        session.stop()
        session = nil
    }

    private func read(_ text: String, onUnauthorized: @escaping (String) -> Void = { _ in }) {
        session.start(text: text,
                      // PCM: the fake synthesizes silence of an exact length, which MP3 can't give.
                      request: SpeechRequest(text: "", voiceID: "voice", stability: 0.5,
                                             token: "stub", format: .pcm(sampleRate: 24_000)),
                      voiceName: "Test", speed: 1, onUnauthorized: onUnauthorized)
    }

    private func waitUntil(_ timeout: Double, _ condition: () -> Bool) async -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if condition() { return true }
            try? await Task.sleep(for: .milliseconds(50))
        }
        return condition()
    }

    func testEmojiAtServiceSegmentLimitStaysTogetherWithoutExceedingLimit() {
        let text = String(repeating: "a", count: 4_499) + "🎉hello"
        let source = text as NSString
        let ranges = TextSegmenter.segments(of: text)
        XCTAssertTrue(ranges.allSatisfy { $0.length <= 4_500 })
        XCTAssertEqual(ranges.map { source.substring(with: $0) }.joined(), text)
    }

    func testInsufficientCreditsStopsBeforeRequestingAnotherSegment() async {
        FakeSpeechService.behavior.status = 402
        read(String(repeating: "Some text. ", count: 600))
        let failed = await waitUntil(3) {
            if case .failed = session.phase { return true }
            return false
        }
        XCTAssertTrue(failed)
        guard case .failed(let message) = session.phase else { return }
        XCTAssertTrue(message.localizedCaseInsensitiveContains("credit"), message)
        XCTAssertEqual(FakeSpeechService.requests.count, 1)
        XCTAssertEqual(analytics.events.filter { $0 == .readingFailed(.credits, partial: false) }.count, 1)
        XCTAssertFalse(analytics.events.contains(.synthesisCompleted))
        XCTAssertFalse(analytics.events.contains(.playbackStarted))
    }

    func testReadsToTheEndAndFinishes() async {
        read("Short and sweet.") // 16 characters → 0.8 s
        let finished = await waitUntil(8) { session.phase == .finished }
        XCTAssertTrue(finished, "never finished; phase is \(session.phase)")
        XCTAssertTrue(session.isComplete)
        XCTAssertEqual(session.duration, 0.8, accuracy: 0.001)
        XCTAssertEqual(session.generatedWords, 3)
        XCTAssertNil(session.currentWord)
        XCTAssertEqual(analytics.events.filter { $0 == .readRequested(characterCount: 16) }.count, 1)
        XCTAssertEqual(analytics.events.filter { $0 == .readingStarted(segmentCount: 1) }.count, 1)
        XCTAssertEqual(analytics.events.filter { $0 == .playbackStarted }.count, 1)
        XCTAssertEqual(analytics.events.filter { $0 == .synthesisCompleted }.count, 1)
        XCTAssertEqual(analytics.events.filter { $0 == .playbackCompleted }.count, 1)
        session.togglePlay()
        XCTAssertTrue(analytics.events.contains(.replay))
        XCTAssertEqual(analytics.events.filter { $0 == .playbackStarted }.count, 1)
    }

    func testHighlightFollowsPlayback() async {
        read("one two three four five six seven eight nine ten")
        let playing = await waitUntil(3) { session.phase == .playing }
        XCTAssertTrue(playing)
        let moved = await waitUntil(3) { (session.currentWord ?? 0) >= 2 }
        XCTAssertTrue(moved, "highlight moved past the first words")
    }

    func testTapToSeekJumpsToTheWordAndKeepsPlaying() async {
        read(String(repeating: "alpha beta gamma delta. ", count: 10)) // ~12 s
        let complete = await waitUntil(5) { session.isComplete }
        XCTAssertTrue(complete)
        let target = 21
        let start = session.timeline!.startTime(ofWord: target)!
        session.seek(toWord: target)
        XCTAssertEqual(session.phase, .playing)
        XCTAssertEqual(session.currentWord, target)
        XCTAssertEqual(session.currentTime, start, accuracy: 0.001)
        try? await Task.sleep(for: .milliseconds(700))
        XCTAssertGreaterThan(session.currentTime, start + 0.2, "kept playing from the tapped word")
        XCTAssertGreaterThanOrEqual(session.currentWord ?? -1, target)
        XCTAssertTrue(analytics.events.contains(.seek))
    }

    func testSeekingPastTheGeneratedAudioIsRefused() async {
        FakeSpeechService.behavior.lineDelay = 0.8 // audio trickles in
        read(String(repeating: "word ", count: 80))
        let playing = await waitUntil(4) { session.phase == .playing }
        XCTAssertTrue(playing)
        let before = session.currentTime
        session.seek(toWord: session.timeline!.words.count - 1)
        XCTAssertEqual(session.notice, "Not generated yet…")
        XCTAssertLessThan(session.currentTime, before + 1, "stayed put")
        XCTAssertFalse(analytics.events.contains(.seek))
    }

    func testPauseHoldsAndResumeContinues() async {
        read(String(repeating: "steady words keep coming. ", count: 8))
        let rolling = await waitUntil(4) { session.phase == .playing && session.currentTime > 0.3 }
        XCTAssertTrue(rolling)
        session.togglePlay()
        XCTAssertEqual(session.phase, .paused)
        let held = session.currentTime
        try? await Task.sleep(for: .milliseconds(400))
        XCTAssertEqual(session.currentTime, held, accuracy: 0.001)
        session.togglePlay()
        let resumed = await waitUntil(2) { session.currentTime > held + 0.2 }
        XCTAssertTrue(resumed)
        session.resume()
        session.stop()
        session.stop()
        XCTAssertEqual(analytics.events.filter { $0 == .playbackChanged(.paused) }.count, 1)
        XCTAssertEqual(analytics.events.filter { $0 == .playbackChanged(.playing) }.count, 1)
        XCTAssertEqual(analytics.events.filter { $0 == .readingStopped }.count, 1)
    }

    func testLongTextIsSeveralRequestsOnOneTimeline() async {
        FakeSpeechService.behavior.secondsPerChar = 0.01
        let text = String(repeating: "This sentence keeps the request comfortably long. ", count: 120) // ~6,000 chars
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        read(text)
        let complete = await waitUntil(15) { session.isComplete }
        XCTAssertTrue(complete)
        XCTAssertEqual(FakeSpeechService.requests.count, 2, "split into two requests")
        XCTAssertEqual(FakeSpeechService.requests.joined(), trimmed, "together they are exactly the text")

        let timeline = session.timeline!
        XCTAssertEqual(timeline.generatedWordCount, timeline.words.count)
        // The second request's first word starts exactly where the first request's audio ended.
        let firstRequest = FakeSpeechService.requests[0]
        let word = timeline.wordIndex(atUTF16: (firstRequest as NSString).length)!
        XCTAssertEqual(timeline.startTime(ofWord: word)!, Double(firstRequest.trimmingCharacters(in: .whitespacesAndNewlines).unicodeScalars.count) * 0.01, accuracy: 0.001)
        let spokenCount = FakeSpeechService.requests.reduce(0) {
            $0 + $1.trimmingCharacters(in: .whitespacesAndNewlines).unicodeScalars.count
        }
        XCTAssertEqual(session.duration, Double(spokenCount) * 0.01, accuracy: 0.001)
        XCTAssertEqual(timeline.timedStarts, timeline.timedStarts.sorted())
    }

    func testExpiredSessionStopsPlaybackAndInvalidatesTheRequestToken() async {
        FakeSpeechService.behavior.status = 401
        var rejected: String?
        read("Hello there.") { rejected = $0 }
        let invalidated = await waitUntil(4) { rejected != nil }
        XCTAssertTrue(invalidated)
        XCTAssertEqual(rejected, "stub")
        XCTAssertEqual(session.phase, .idle)
        XCTAssertNil(session.timeline)
    }

    func testTruncatedSynthesisReportsPartialWithoutACompletion() async {
        FakeSpeechService.behavior.secondsPerChar = 0.002
        FakeSpeechService.behavior.secondRequestStatus = 402
        read(String(repeating: "Long reading. ", count: 360))
        let failed = await waitUntil(8) { self.analytics.events.contains(.readingFailed(.credits, partial: true)) }
        XCTAssertTrue(failed)
        XCTAssertFalse(analytics.events.contains(.synthesisCompleted))
        XCTAssertGreaterThan(session.duration, 0)
    }

    func testPreferenceEventsOnlyFireForChangesAndNeverIncludeTheVoiceID() {
        let preferences = AppSettings(defaults: UserDefaults(suiteName: UUID().uuidString)!, analytics: analytics)
        preferences.voiceID = "private-voice-reference"
        preferences.voiceID = "private-voice-reference"
        preferences.voiceName = "Private Voice Name"
        preferences.speed = 1.25
        preferences.stability = 1
        preferences.fontSizeEditingChanged(true)
        preferences.fontSize = 21
        preferences.fontSize = 22
        preferences.fontSize = 23
        preferences.fontSizeEditingChanged(false)
        preferences.fontSizeEditingChanged(true)
        preferences.fontSize = 24
        preferences.fontSize = 23
        preferences.fontSizeEditingChanged(false)
        XCTAssertEqual(analytics.events, [.settingChanged(.voice), .settingChanged(.speed),
                                          .settingChanged(.stability), .settingChanged(.fontSize)])
    }

    func testEachPreviewEmitsOnlyOneOutcome() async {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [FakeSpeechService.self]
        let preview = VoicePreviewer(client: ServiceClient(session: URLSession(configuration: config)))
        FakeSpeechService.behavior.status = 402
        preview.toggle(Voice.fallback, token: "stub", analytics: analytics) { _ in XCTFail() }
        preview.stop()
        preview.toggle(Voice.fallback, token: "stub", analytics: analytics) { _ in XCTFail() }
        let failed = await waitUntil(3) { preview.error != nil }
        XCTAssertTrue(failed)
        preview.stop()
        XCTAssertEqual(analytics.events, [.voicePreview(.cancelled), .voicePreview(.failed)])
    }
}
