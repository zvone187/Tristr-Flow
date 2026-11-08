import XCTest
@testable import TristrFlow

final class NDJSONLineSplitterTests: XCTestCase {
    func testSplitsAcrossArbitraryChunkBoundaries() {
        let lines = [#"{"a":1}"#, #"{"b":"two"}"#, #"{"c":[3,4]}"#]
        let stream = Data((lines.joined(separator: "\n") + "\n").utf8)
        for size in [1, 2, 3, 7, 64, stream.count] {
            var splitter = NDJSONLineSplitter()
            var got: [String] = []
            var i = 0
            while i < stream.count {
                got += splitter.append(Data(stream[i..<min(i + size, stream.count)])).map { String(decoding: $0, as: UTF8.self) }
                i += size
            }
            XCTAssertEqual(got, lines, "chunk size \(size)")
            XCTAssertNil(splitter.finish())
        }
    }

    func testCRLFBlankLinesAndAnUnterminatedLastLine() {
        var splitter = NDJSONLineSplitter()
        let got = splitter.append(Data("{\"a\":1}\r\n\n  \n{\"b\":2}".utf8)).map { String(decoding: $0, as: UTF8.self) }
        XCTAssertEqual(got, ["{\"a\":1}"])
        XCTAssertEqual(splitter.finish().map { String(decoding: $0, as: UTF8.self) }, "{\"b\":2}")
    }

    func testUnicodeLineSeparatorInsideJSONDoesNotEndTheLine() {
        // AsyncBytes.lines would break this line in two at U+2028.
        let line = "{\"characters\":[\"\u{2028}\",\"x\"]}"
        var splitter = NDJSONLineSplitter()
        let got = splitter.append(Data((line + "\n").utf8))
        XCTAssertEqual(got.map { String(decoding: $0, as: UTF8.self) }, [line])
    }

    func testDecodesARealStreamLine() throws {
        let json = #"{"audio":"AQD//w==","alignment":{"characters":["H","i"],"character_start_times_seconds":[0.0,0.1],"character_end_times_seconds":[0.1,0.2]},"normalized_alignment":null}"#
        let line = try JSONDecoder().decode(StreamLine.self, from: Data(json.utf8))
        XCTAssertEqual(line.alignment?.characters, ["H", "i"])
        var pcm = PCM16Decoder()
        XCTAssertEqual(pcm.decode(Data(base64Encoded: line.audioBase64!)!), [1, -1])
    }
}

final class PCM16DecoderTests: XCTestCase {
    func testLittleEndianSignedSamples() {
        var decoder = PCM16Decoder()
        let bytes: [UInt8] = [0x01, 0x00, 0xFF, 0xFF, 0xFF, 0x7F, 0x00, 0x80]
        XCTAssertEqual(decoder.decode(Data(bytes)), [1, -1, 32767, -32768])
    }

    func testCarriesAnOddByteAcrossChunks() {
        let samples: [Int16] = (0..<1000).map { Int16(truncatingIfNeeded: $0 * 37 - 18000) }
        var bytes: [UInt8] = []
        for s in samples {
            let u = UInt16(bitPattern: s)
            bytes += [UInt8(u & 0xFF), UInt8(u >> 8)]
        }
        for split in [1, 3, 5, 333, 1999] {
            var decoder = PCM16Decoder()
            var out = decoder.decode(Data(bytes[0..<split]))
            out += decoder.decode(Data(bytes[split...]))
            XCTAssertEqual(out, samples, "split at byte \(split)")
            XCTAssertFalse(decoder.hasDanglingByte)
        }
    }
}

final class TextSegmenterTests: XCTestCase {
    func testShortAndEmptyText() {
        XCTAssertEqual(TextSegmenter.segments(of: "Hello."), [NSRange(location: 0, length: 6)])
        XCTAssertEqual(TextSegmenter.segments(of: ""), [])
    }

    func testPiecesAreContiguousRejoinExactlyAndRespectTheLimit() {
        let text = String(repeating: "The quick brown fox jumps over the lazy dog. ", count: 400) + "Last 🎉 words."
        let ns = text as NSString
        let segments = TextSegmenter.segments(of: text)
        XCTAssertGreaterThan(segments.count, 1)
        var cursor = 0
        for r in segments {
            XCTAssertEqual(r.location, cursor)
            XCTAssertLessThanOrEqual(r.length, TextSegmenter.defaultMaxLength + 1) // +1: surrogate fix-up
            cursor = NSMaxRange(r)
        }
        XCTAssertEqual(cursor, ns.length)
        XCTAssertEqual(segments.map { ns.substring(with: $0) }.joined(), text)
    }

    func testCutsAtSentenceEnds() {
        let text = String(repeating: "Sentence number one is here. ", count: 300)
        let ns = text as NSString
        for r in TextSegmenter.segments(of: text, maxLength: 1000).dropLast() {
            XCTAssertTrue(ns.substring(with: r).hasSuffix(". "))
        }
    }

    func testNeverCutsAnEmojiInHalf() {
        let text = String(repeating: "🎉", count: 3000) // no spaces or sentences: forces hard cuts
        let ns = text as NSString
        for r in TextSegmenter.segments(of: text, maxLength: 1001) { // odd limit lands mid-pair
            XCTAssertFalse((0xDC00...0xDFFF).contains(ns.character(at: r.location)), "starts on a low surrogate")
            XCTAssertFalse((0xD800...0xDBFF).contains(ns.character(at: NSMaxRange(r) - 1)), "ends on a high surrogate")
        }
    }
}

private final class ServiceStub: URLProtocol {
    static var respond: ((URLRequest) throws -> (Int, String))?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        do {
            let (status, text) = try XCTUnwrap(Self.respond)(request)
            let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil)!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: Data(text.utf8))
            client?.urlProtocolDidFinishLoading(self)
        } catch {
            client?.urlProtocol(self, didFailWithError: error)
        }
    }

    override func stopLoading() {}

    static func body(_ request: URLRequest) throws -> [String: Any] {
        var data = request.httpBody ?? Data()
        if data.isEmpty, let stream = request.httpBodyStream {
            stream.open()
            defer { stream.close() }
            var buf = [UInt8](repeating: 0, count: 1_024)
            while true {
                let n = stream.read(&buf, maxLength: buf.count)
                if n <= 0 { break }
                data.append(buf, count: n)
            }
        }
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }
}

final class ServiceContractTests: XCTestCase {
    private var client: ServiceClient!

    override func setUp() {
        super.setUp()
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [ServiceStub.self]
        client = ServiceClient(session: URLSession(configuration: config))
    }

    override func tearDown() {
        ServiceStub.respond = nil
        super.tearDown()
    }

    func testLoginAndAccountUseTheSameServiceButOnlyAccountReceivesBearerToken() async throws {
        ServiceStub.respond = { req in
            XCTAssertEqual(req.url?.host, "tristr-flow-5iy7.onrender.com")
            XCTAssertEqual(req.url?.scheme, "https")
            XCTAssertFalse(req.httpShouldHandleCookies)
            if req.url?.path == "/api/auth/login" {
                XCTAssertEqual(req.httpMethod, "POST")
                XCTAssertNil(req.value(forHTTPHeaderField: "Authorization"))
                let body = try ServiceStub.body(req)
                XCTAssertEqual(body as? [String: String], ["email": "a@example.test", "password": "example-pass"])
                return (200, #"{"ok":true,"email":"a@example.test","apiToken":"session-token","creditsMicros":"12500"}"#)
            }
            XCTAssertEqual(req.url?.path, "/api/me")
            XCTAssertEqual(req.httpMethod, "GET")
            XCTAssertEqual(req.value(forHTTPHeaderField: "Authorization"), "Bearer session-token")
            return (200, #"{"email":"a@example.test","minutesLeft":19,"plan":"free","creditsMicros":"12500"}"#)
        }
        let login = try await client.login(email: "a@example.test", password: "example-pass")
        XCTAssertEqual(login.email, "a@example.test")
        let account = try await client.me(token: login.apiToken)
        XCTAssertEqual(account.email, login.email)
        XCTAssertEqual(account.minutesLeft, 19)
        XCTAssertEqual(account.plan, "free")
    }

    func testUnauthorizedAccountDiffersFromBadLogin() async {
        ServiceStub.respond = { _ in (401, #"{"error":"Not authenticated"}"#) }
        do {
            _ = try await client.me(token: "invalid")
            XCTFail("A rejected session must be signed out")
        } catch { XCTAssertEqual(error as? ServiceError, .unauthorized) }
        do {
            _ = try await client.login(email: "a@example.test", password: "bad")
            XCTFail("Login should fail")
        } catch { XCTAssertEqual(error as? ServiceError, .invalidCredentials) }
    }

    private let request = SpeechRequest(text: "Hi", voiceID: "curated", stability: 0.5,
                                        token: "session-token", format: .pcm(sampleRate: 24_000))

    func testMeteredSpeechSendsBearerAndDecodesBackendAudioAndCompletion() async throws {
        ServiceStub.respond = { req in
            XCTAssertEqual(req.url?.host, "tristr-flow-5iy7.onrender.com")
            XCTAssertEqual(req.url?.path, "/api/tts")
            XCTAssertEqual(req.httpMethod, "POST")
            XCTAssertEqual(req.value(forHTTPHeaderField: "Authorization"), "Bearer session-token")
            XCTAssertEqual(req.value(forHTTPHeaderField: "Accept"), "application/x-ndjson")
            XCTAssertNil(req.value(forHTTPHeaderField: "xi-api-key"))
            let body = try ServiceStub.body(req)
            XCTAssertEqual(Set(body.keys), ["text", "voiceId", "stability"])
            XCTAssertEqual(body["text"] as? String, "Hi")
            XCTAssertEqual(body["voiceId"] as? String, "curated")
            XCTAssertEqual(body["stability"] as? Double, 0.5)
            return (200, [
                #"{"type":"segment","index":0}"#,
                #"{"audio":"AQD//w==","alignment":{"characters":["H","i"],"character_start_times_seconds":[0,0.1],"character_end_times_seconds":[0.1,0.2]}}"#,
                #"{"type":"done"}"#
            ].joined(separator: "\n"))
        }
        var chunks: [SpeechChunk] = []
        for try await chunk in client.stream(request) { chunks.append(chunk) }
        XCTAssertEqual(chunks.count, 1)
        XCTAssertEqual(chunks.first?.samples, [1, -1])
        XCTAssertEqual(chunks.first?.alignment?.characters, ["H", "i"])
    }

    func testStreamPropagatesCreditFailureAfterSuccessfulHTTPResponse() async {
        ServiceStub.respond = { _ in (200, #"{"type":"error","message":"insufficient_credits"}"# + "\n" + #"{"type":"done"}"#) }
        do {
            for try await _ in client.stream(request) {}
            XCTFail("In-stream credit rejection must not appear to complete")
        } catch { XCTAssertEqual(error as? ServiceError, .insufficientCredits) }
    }

    func testTruncatedSpeechIsNotTreatedAsACompletedRead() async {
        ServiceStub.respond = { _ in (200, #"{"type":"segment","index":0}"#) }
        do {
            for try await _ in client.stream(request) {}
            XCTFail("Backend did not send its completion frame")
        } catch { XCTAssertEqual(error as? ServiceError, .badResponse) }
    }
}

extension ServiceContractTests {
    func testFishCharacterTimingWithAnEmojiKeepsTheNextWordAligned() throws {
        let json = #"{"alignment":{"characters":["\ud83d","\ude04"," ","H","i"],"character_start_times_seconds":[0,0.1,0.2,0.3,0.4],"character_end_times_seconds":[0.1,0.2,0.3,0.4,0.5]}}"#
        let frame = try StreamLine.decode(Data(json.utf8), fish: true)
        let timeline = Timeline(text: "😄 Hi")
        timeline.apply(try XCTUnwrap(frame.alignment), timeOffset: 0)
        XCTAssertEqual(timeline.startTime(ofWord: 0), 0)
        XCTAssertEqual(timeline.startTime(ofWord: 1), 0.3)
    }

    func testCredentialAndSpeechRedirectsAreRefused() {
        let external = URL(string: "https://foreign.example")!
        for code in [301, 302, 303, 307, 308] {
            let redirected = HTTPURLResponse(url: external, statusCode: code, httpVersion: nil, headerFields: nil)!
            var followed = true
            ServiceRedirectPolicy.shared.urlSession(.shared, task: URLSession.shared.dataTask(with: external),
                                                    willPerformHTTPRedirection: redirected, newRequest: URLRequest(url: external)) {
                followed = $0 != nil
            }
            XCTAssertFalse(followed, "HTTP \(code) must not forward credentials or reading text")
        }
    }
}
