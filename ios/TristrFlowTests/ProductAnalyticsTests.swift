import XCTest
@testable import TristrFlow

private final class AnalyticsHTTPStub: URLProtocol {
    static var handler: ((URLRequest, [String: Any]) -> Int)?
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        var body = request.httpBody ?? Data()
        if body.isEmpty, let input = request.httpBodyStream {
            input.open()
            defer { input.close() }
            var buf = [UInt8](repeating: 0, count: 1024)
            while true {
                let n = input.read(&buf, maxLength: buf.count)
                if n <= 0 { break }
                body.append(buf, count: n)
            }
        }
        let json = (try? JSONSerialization.jsonObject(with: body)) as? [String: Any] ?? [:]
        let result = Self.handler?(request, json) ?? 200
        let response = HTTPURLResponse(url: request.url!, statusCode: result, httpVersion: nil, headerFields: nil)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data("{}".utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

final class ProductAnalyticsTests: XCTestCase {
    private var file: URL!
    private var session: URLSession!

    override func setUp() {
        super.setUp()
        file = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
            .appendingPathComponent("queue.json")
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [AnalyticsHTTPStub.self]
        session = URLSession(configuration: config)
    }

    override func tearDown() {
        AnalyticsHTTPStub.handler = nil
        try? FileManager.default.removeItem(at: file.deletingLastPathComponent())
        super.tearDown()
    }

    private func delivery() -> AnalyticsDelivery {
        AnalyticsDelivery(file: file, endpoint: URL(string: "https://analytics.example/batch/")!,
                          projectToken: "fixture", session: session, automatic: false)
    }

    func testFailedUploadRestartsWithTheSameEventTimeIDAndInstallation() async throws {
        var requests = [[String: Any]]()
        AnalyticsHTTPStub.handler = { request, body in
            XCTAssertEqual(request.httpMethod, "POST")
            XCTAssertFalse(request.httpShouldHandleCookies)
            XCTAssertNil(request.value(forHTTPHeaderField: "Authorization"))
            XCTAssertEqual(body["api_key"] as? String, "fixture")
            requests.append((body["batch"] as? [[String: Any]])?.first ?? [:])
            return requests.count == 1 ? 503 : 200
        }
        let record = ProductEvent.readRequested(characterCount: 20_000_000).record(appVersion: "1.2")
        let first = delivery()
        first.enqueue(record)
        await first.flush()
        let restarted = delivery()
        await restarted.flush()
        await restarted.flush()
        XCTAssertEqual(requests.count, 2)
        guard requests.count == 2 else { return }
        for key in ["uuid", "timestamp", "distinct_id"] {
            let firstValue = try XCTUnwrap(requests[0][key] as? String)
            XCTAssertEqual(firstValue, requests[1][key] as? String)
        }
        XCTAssertNotNil(UUID(uuidString: try XCTUnwrap(requests[0]["distinct_id"] as? String)))
        let timestamp = try XCTUnwrap(requests[0]["timestamp"] as? String)
        XCTAssertNoThrow(try Date(timestamp, strategy: Date.ISO8601FormatStyle(includingFractionalSeconds: true)))
        let properties = try XCTUnwrap(requests[0]["properties"] as? [String: Any])
        XCTAssertEqual(Set(properties.keys), ["app_version","platform","$geoip_disable","$process_person_profile","character_count"])
        XCTAssertEqual(properties["$geoip_disable"] as? Bool, true)
        XCTAssertEqual(properties["$process_person_profile"] as? Bool, false)
        XCTAssertEqual(properties["platform"] as? String, "ios")
        XCTAssertEqual(properties["character_count"] as? Int, 5_000_000)
        XCTAssertEqual(requests[0]["event"] as? String, "read_requested")
    }

    func testQueueIsBoundedAndPermanentlyRejectedBatchIsNotRetried() async throws {
        let sink = delivery()
        for n in 1...112 { sink.enqueue(ProductEvent.readRequested(characterCount: n).record(appVersion: "1.0")) }
        var batches = [[Int]]()
        AnalyticsHTTPStub.handler = { _, body in
            batches.append((body["batch"] as? [[String: Any]])?.compactMap {
                ($0["properties"] as? [String: Any])?["character_count"] as? Int
            } ?? [])
            return 400
        }
        await sink.flush()
        await delivery().flush()
        XCTAssertEqual(batches, [Array(13...112)])
    }

    func testMissingOrMalformedProjectTokenDisablesProductionCapture() {
        XCTAssertNil(ProductAnalytics.projectToken(Data()))
        XCTAssertNil(ProductAnalytics.projectToken(Data("{}".utf8)))
        XCTAssertNil(ProductAnalytics.projectToken(Data(#"{"projectToken":"wrong"}"#.utf8)))
        XCTAssertEqual(ProductAnalytics.projectToken(Data(#"{"projectToken":"phc_1234567890abcdef"}"#.utf8)), "phc_1234567890abcdef")
    }

    func testSimulatorRequiresExplicitLoopbackCaptureEndpoint() {
        XCTAssertNil(ProductAnalytics.fixtureEndpoint(nil))
        XCTAssertNil(ProductAnalytics.fixtureEndpoint("https://us.i.posthog.com/batch/"))
        XCTAssertNil(ProductAnalytics.fixtureEndpoint("http://127.0.0.1.attacker.test:4000/batch/"))
        XCTAssertNil(ProductAnalytics.fixtureEndpoint("http://secret@127.0.0.1:4000/batch/"))
        XCTAssertNil(ProductAnalytics.fixtureEndpoint("http://127.0.0.1:4000/elsewhere"))
        XCTAssertEqual(ProductAnalytics.fixtureEndpoint("http://127.0.0.1:4000/batch/")?.port, 4000)
    }
}
