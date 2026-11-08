import Network
import XCTest

final class ReadAloudUITests: XCTestCase {
    override func setUpWithError() throws {
        try super.setUpWithError()
        #if !targetEnvironment(simulator)
        throw XCTSkip("These tests require the simulator's loopback backend and analytics receiver.")
        #endif
    }

    @MainActor
    func testAccountPlaybackRestorationAndSignOut() throws {
        continueAfterFailure = false
        let server = try ReaderTestService()
        defer { server.stop() }
        let app = try launch(with: server, captureAnalytics: true)
        let email = app.textFields["signInEmail"]
        XCTAssertTrue(email.waitForExistence(timeout: 12), "A new customer can sign in without a provider key")
        attachScreen(app, name: "Account sign-in")
        enterCredentials(in: app)

        let editor = app.textViews["composeEditor"]
        XCTAssertTrue(editor.waitForExistence(timeout: 10))
        XCTAssertEqual(server.snapshot.logins, 1)
        XCTAssertTrue(eventually {
            server.snapshot.observed("account_action_completed", ["action": "login", "outcome": "success"])
        }, "A successful login reaches the local analytics receiver")
        let previousLookups = server.snapshot.accountLookups
        app.terminate()
        app.launch()
        XCTAssertTrue(editor.waitForExistence(timeout: 10))
        XCTAssertEqual(server.snapshot.logins, 1, "Relaunch uses the saved token")
        XCTAssertGreaterThan(server.snapshot.accountLookups, previousLookups)

        editor.tap()
        editor.typeText(ReaderTestService.passage)
        app.buttons["readAloud"].tap()

        let clock = app.staticTexts["currentTime"]
        let transport = app.buttons["playPause"]
        XCTAssertTrue(clock.waitForExistence(timeout: 10))
        XCTAssertTrue(eventually { (Double(clock.value as? String ?? "") ?? 0) > 0.2 })
        XCTAssertTrue(eventually { app.staticTexts["duration"].value as? String == "complete" })
        attachScreen(app, name: "Backend narration")
        XCTAssertTrue(eventually { transport.label == "Play" }, "Finished playing the MP3 fixture")
        XCTAssertEqual(server.snapshot.reads, 1)
        XCTAssertEqual(server.snapshot.balance, ReaderTestService.openingBalance - ReaderTestService.passage.utf16.count * 200)

        let reader = app.textViews["readerText"]
        let firstWord = reader.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: 34, dy: 30))
        firstWord.tap()
        XCTAssertTrue(eventually { transport.label == "Pause" }, "Tapping the first word replays the buffered clip")
        transport.tap()
        XCTAssertTrue(eventually { app.staticTexts["status"].label == "Paused" })
        XCTAssertEqual(server.snapshot.reads, 1, "Seeking reuses the buffered audio")

        app.buttons["settings"].tap()
        app.buttons["signOut"].tap()
        XCTAssertTrue(email.waitForExistence(timeout: 5))
        XCTAssertTrue(eventually {
            server.snapshot.observed("account_action_completed", ["action": "logout", "outcome": "success"])
        })
        let lookupsAfterSignOut = server.snapshot.accountLookups
        app.terminate()
        app.launch()
        XCTAssertTrue(email.waitForExistence(timeout: 10))
        XCTAssertEqual(server.snapshot.accountLookups, lookupsAfterSignOut)
        XCTAssertFalse(editor.exists)
        XCTAssertTrue(eventually { server.snapshot.events.filter { $0.name == "app_launched" }.count == 3 })
        let ledger = server.snapshot
        XCTAssertTrue(ledger.observed("account_action_completed", ["action": "restore", "outcome": "success"]))
        for screen in ["sign_in", "compose", "reader", "settings"] {
            XCTAssertTrue(ledger.observed("window_opened", ["surface": screen]), "Missing screen: \(screen)")
        }
        for event in ["read_requested", "reading_started", "reading_playback_started",
                      "reading_synthesis_completed", "reading_playback_completed"] {
            XCTAssertTrue(ledger.observed(event), "Missing event: \(event)")
        }
        XCTAssertTrue(ledger.observed("overlay_interaction", ["interaction": "seek"]))
        XCTAssertTrue(ledger.observed("reading_playback_state_changed", ["playback_state": "paused"]))
        XCTAssertEqual(Set(ledger.events.map(\.installation)).count, 1, "Anonymous installation survives relaunch and logout")
        XCTAssertEqual(Set(ledger.events.map(\.id)).count, ledger.events.count, "Each distinct action has an event ID")
        XCTAssertFalse(ledger.analyticsPrivacyViolation, "Unexpected personal data, identifiers, credentials, or profile settings")
    }

    @MainActor
    func testLoginRejectsRedirectWithoutSendingPasswordAgain() throws {
        continueAfterFailure = false
        let server = try ReaderTestService(redirectLogin: true)
        defer { server.stop() }
        let app = try launch(with: server)
        XCTAssertTrue(app.textFields["signInEmail"].waitForExistence(timeout: 12))
        enterCredentials(in: app)
        let message = app.staticTexts["signInMessage"]
        XCTAssertTrue(eventually { message.exists && message.label.contains("307") })
        XCTAssertEqual(server.snapshot.logins, 1)
        XCTAssertEqual(server.snapshot.redirectTargetsReached, 0, "The password must never reach a redirected endpoint")
        XCTAssertFalse(app.textViews["composeEditor"].exists)
    }

    @MainActor
    private func launch(with server: ReaderTestService, captureAnalytics: Bool = false) throws -> XCUIApplication {
        let listening = expectation(description: "Local account service is listening")
        server.start { listening.fulfill() }
        wait(for: [listening], timeout: 5)
        let port = try XCTUnwrap(server.port)
        let app = XCUIApplication()
        app.launchEnvironment["TRISTR_TEST_SERVICE_URL"] = "http://127.0.0.1:\(port)"
        if captureAnalytics { app.launchEnvironment["TRISTR_TEST_ANALYTICS_URL"] = "http://127.0.0.1:\(port)/batch/" }
        app.launchArguments = ["-speed", "0.75"]
        app.launch()
        return app
    }

    @MainActor
    private func enterCredentials(in app: XCUIApplication) {
        let email = app.textFields["signInEmail"]
        email.tap()
        email.typeText(ReaderTestService.email)
        let password = app.secureTextFields["signInPassword"]
        password.tap()
        password.typeText(ReaderTestService.password)
        app.buttons["signInSubmit"].tap()
    }

    @MainActor
    private func attachScreen(_ app: XCUIApplication, name: String) {
        let image = XCTAttachment(screenshot: app.screenshot())
        image.name = name
        image.lifetime = .keepAlways
        add(image)
    }

    private func eventually(_ check: () -> Bool) -> Bool {
        let deadline = Date().addingTimeInterval(10)
        while !check() && Date() < deadline {
            RunLoop.current.run(until: Date().addingTimeInterval(0.12))
        }
        return check()
    }
}

/// A separate process (the app) reaches this server over real HTTP. It returns the
/// deployed service's wire format and accounts only for requests with this run's token.
private final class ReaderTestService {
    static let email = "reader@example.test"
    static let password = "example-reader-pass"
    static let passage = "Fixtures keep the decoder honest, one frame at a time."
    static let openingBalance = 100_000

    struct AnalyticsEvent {
        let name: String
        let id: UUID
        let installation: UUID
        let properties: [String: String]
    }

    struct Ledger {
        var events = [AnalyticsEvent]()
        var analyticsPrivacyViolation = false
        func observed(_ name: String, _ properties: [String: String] = [:]) -> Bool {
            events.contains { event in
                event.name == name && properties.allSatisfy { event.properties[$0.key] == $0.value }
            }
        }

        var logins = 0
        var redirectTargetsReached = 0
        var accountLookups = 0
        var reads = 0
        var balance = ReaderTestService.openingBalance
    }

    private let queue = DispatchQueue(label: "TristrFlow.readerTestService")
    private let listener: NWListener
    private let token = UUID().uuidString
    private let redirectLogin: Bool
    private var ledger = Ledger()
    var snapshot: Ledger { queue.sync { ledger } }
    var port: UInt16? { listener.port?.rawValue }

    init(redirectLogin: Bool = false) throws {
        self.redirectLogin = redirectLogin
        let parameters = NWParameters.tcp
        parameters.requiredLocalEndpoint = NWEndpoint.hostPort(host: "127.0.0.1", port: .any)
        listener = try NWListener(using: parameters)
    }

    func start(onReady: @escaping () -> Void) {
        listener.stateUpdateHandler = { state in
            if case .ready = state { onReady() }
            if case .failed(let error) = state { XCTFail("Local service failed: \(error)") }
        }
        listener.newConnectionHandler = { connection in
            connection.start(queue: self.queue)
            self.receive(connection, data: Data())
        }
        listener.start(queue: queue)
    }

    func stop() { listener.cancel() }

    private func receive(_ connection: NWConnection, data: Data) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 32_768) { more, _, complete, error in
            guard error == nil, let more, !more.isEmpty else { connection.cancel(); return }
            let payload = data + more
            if let request = HTTPRequest(payload) {
                let response = self.response(to: request)
                connection.send(content: response, completion: .contentProcessed { _ in connection.cancel() })
            } else if payload.count < 65_536, !complete {
                self.receive(connection, data: payload)
            } else {
                connection.cancel()
            }
        }
    }

    private func response(to request: HTTPRequest) -> Data {
        if request.endpoint == "POST /batch/" { return ingestAnalytics(request) }
        if request.endpoint == "POST /api/auth/login" {
            guard request.body["email"] as? String == Self.email,
                  request.body["password"] as? String == Self.password else {
                return json(["error": "Wrong email or password."], status: 401)
            }
            ledger.logins += 1
            if redirectLogin {
                return Data("HTTP/1.1 307 Temporary Redirect\r\nLocation: /redirect-target\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".utf8)
            }
            return json(["ok": true, "email": Self.email, "apiToken": token, "creditsMicros": String(ledger.balance)])
        }
        if request.endpoint == "POST /redirect-target" || request.endpoint == "GET /redirect-target" {
            ledger.redirectTargetsReached += 1
            return json(["error": "unexpected_redirect"], status: 400)
        }
        guard request.headers["authorization"] == "Bearer \(token)" else {
            return json(["error": "not_authenticated"], status: 401)
        }
        switch request.endpoint {
        case "GET /api/me":
            ledger.accountLookups += 1
            return json(["email": Self.email, "apiToken": token, "creditsMicros": String(ledger.balance),
                         "creditsDollars": "0.10", "minutesLeft": 1, "plan": "free"])
        case "GET /api/voices":
            return json(["voices": []])
        case "POST /api/tts":
            guard request.body["text"] as? String == Self.passage,
                  let voice = request.body["voiceId"] as? String, !voice.isEmpty else {
                return json(["error": "invalid_read"], status: 400)
            }
            do {
                let payload = try audioResponse()
                ledger.reads += 1
                ledger.balance -= Self.passage.utf16.count * 200
                return http(status: 200, type: "application/x-ndjson", body: payload)
            } catch {
                XCTFail("Cannot read fixture: \(error)")
                return json(["error": "fixture_missing"], status: 500)
            }
        default:
            return json(["error": "not_found"], status: 404)
        }
    }

    private func ingestAnalytics(_ request: HTTPRequest) -> Data {
        guard request.body["api_key"] as? String == "tristr-local-fixture",
              let batch = request.body["batch"] as? [[String: Any]], !batch.isEmpty else {
            return json(["error": "invalid_batch"], status: 400)
        }
        let forbiddenValues = [Self.email, Self.password, Self.passage, "decoder honest", token]
        let bodyText = (try? JSONSerialization.data(withJSONObject: request.body)).map { String(decoding: $0, as: UTF8.self) } ?? ""
        let content = ([bodyText] + Array(request.headers.values)).joined(separator: " ")
        if forbiddenValues.contains(where: content.contains) || request.headers["authorization"] != nil || request.headers["cookie"] != nil {
            ledger.analyticsPrivacyViolation = true
        }
        let privateProperties: Set<String> = ["$set", "$set_once", "$ip", "ip", "$geoip_latitude", "$geoip_longitude",
                                              "email", "password", "text", "token", "access_token", "voice_id", "voiceId"]
        for event in batch {
            guard let name = event["event"] as? String,
                  let id = (event["uuid"] as? String).flatMap(UUID.init(uuidString:)),
                  let installation = (event["distinct_id"] as? String).flatMap(UUID.init(uuidString:)),
                  let properties = event["properties"] as? [String: Any] else {
                ledger.analyticsPrivacyViolation = true
                continue
            }
            if properties["platform"] as? String != "ios" || properties["$geoip_disable"] as? Bool != true
                || properties["$process_person_profile"] as? Bool != false
                || !privateProperties.isDisjoint(with: properties.keys) || name.hasPrefix("$identify") {
                ledger.analyticsPrivacyViolation = true
            }
            ledger.events.append(.init(name: name, id: id, installation: installation, properties: properties.compactMapValues { $0 as? String }))
        }
        return json(["status": 1])
    }

    private func audioResponse() throws -> Data {
        let url = try XCTUnwrap(Bundle(for: ReadAloudUITests.self).url(forResource: "mp3_44100_64", withExtension: "ndjson"))
        let source = try String(contentsOf: url, encoding: .utf8)
        var lines: [[String: Any]] = [["type": "segment", "index": 0]]
        for line in source.split(whereSeparator: { $0.isNewline }) {
            let object = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any])
            lines.append(["audio": try XCTUnwrap(object["audio_base64"]), "alignment": object["alignment"] ?? NSNull()])
        }
        lines.append(["type": "done"])
        var data = Data()
        for line in lines {
            data.append(try JSONSerialization.data(withJSONObject: line))
            data.append(10)
        }
        return data
    }

    private func json(_ object: [String: Any], status: Int = 200) -> Data {
        http(status: status, type: "application/json", body: (try? JSONSerialization.data(withJSONObject: object)) ?? Data())
    }

    private func http(status: Int, type: String, body: Data) -> Data {
        Data("HTTP/1.1 \(status) \(status == 200 ? "OK" : "Error")\r\nContent-Type: \(type)\r\nContent-Length: \(body.count)\r\nConnection: close\r\n\r\n".utf8) + body
    }

    private struct HTTPRequest {
        let endpoint: String
        let headers: [String: String]
        let body: [String: Any]

        init?(_ data: Data) {
            guard let separator = data.range(of: Data("\r\n\r\n".utf8)) else { return nil }
            let lines = String(decoding: data[..<separator.lowerBound], as: UTF8.self).components(separatedBy: "\r\n")
            let parts = lines[0].split(separator: " ")
            guard parts.count >= 2 else { return nil }
            endpoint = "\(parts[0]) \(parts[1])"
            var fields: [String: String] = [:]
            for line in lines.dropFirst() {
                guard let colon = line.firstIndex(of: ":") else { continue }
                let key = line[..<colon].lowercased()
                fields[key] = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
            }
            headers = fields
            let length = Int(fields["content-length"] ?? "0") ?? 0
            let bytes = data[separator.upperBound...]
            guard bytes.count >= length else { return nil }
            body = (try? JSONSerialization.jsonObject(with: bytes) as? [String: Any]) ?? [:]
        }
    }
}
