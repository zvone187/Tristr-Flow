import Foundation

@MainActor
protocol ProductTracking: AnyObject {
    func capture(_ event: ProductEvent)
}

/// Only these actions and properties can enter the analytics queue.
enum ProductEvent: Equatable, Sendable {
    enum Action: String { case login, logout, restore, expired }
    enum Outcome: String { case success, failed, cancelled, rejected, noSession = "no_session" }
    enum Screen: String { case signIn = "sign_in", compose, reader, settings }
    enum PlaybackState: String { case playing, paused }
    enum Setting: String { case voice, speed, stability, fontSize = "font_size" }
    enum FailureReason: String { case unauthorized, credits, network, service, audio, unknown }

    case appLaunched, appForegrounded, appBackgrounded
    case account(action: Action, outcome: Outcome)
    case screenViewed(Screen)
    case textPasted, readRejected
    case readRequested(characterCount: Int)
    case readingStarted(segmentCount: Int)
    case playbackStarted, playbackCompleted, synthesisCompleted, readingStopped
    case playbackChanged(PlaybackState)
    case readingFailed(FailureReason, partial: Bool)
    case seek, replay
    case voicePreview(Outcome)
    case voiceList(Outcome, count: Int)
    case settingChanged(Setting)

    private var fields: (name: String, properties: [String: AnalyticsValue]) {
        switch self {
        case .appLaunched: return ("app_launched", [:])
        case .appForegrounded: return ("app_foregrounded", [:])
        case .appBackgrounded: return ("app_backgrounded", [:])
        case let .account(action, outcome):
            return ("account_action_completed", ["action": .string(action.rawValue), "outcome": .string(outcome.rawValue)])
        case .screenViewed(let screen):
            return ("window_opened", ["surface": .string(screen.rawValue)])
        case .textPasted: return ("text_pasted", [:])
        case .readRejected: return ("read_rejected", ["reason": .string("empty")])
        case .readRequested(let count):
            return ("read_requested", ["character_count": .integer(min(max(count, 0), 5_000_000))])
        case .readingStarted(let count):
            return ("reading_started", ["segment_count": .integer(min(max(count, 0), 10_000))])
        case .playbackStarted: return ("reading_playback_started", [:])
        case .playbackCompleted: return ("reading_playback_completed", [:])
        case .synthesisCompleted: return ("reading_synthesis_completed", [:])
        case .readingStopped: return ("reading_stopped", [:])
        case .playbackChanged(let state):
            return ("reading_playback_state_changed", ["playback_state": .string(state.rawValue)])
        case let .readingFailed(reason, partial):
            return ("reading_failed", ["reason": .string(reason.rawValue), "partial": .bool(partial)])
        case .seek: return ("overlay_interaction", ["interaction": .string("seek")])
        case .replay: return ("overlay_interaction", ["interaction": .string("replay")])
        case .voicePreview(let outcome):
            return ("voice_preview_completed", ["outcome": .string(outcome.rawValue)])
        case let .voiceList(outcome, count):
            return ("voice_list_completed", ["outcome": .string(outcome.rawValue), "voice_count": .integer(min(max(count, 0), 100_000))])
        case .settingChanged(let setting):
            return ("setting_changed", ["setting_name": .string(setting.rawValue)])
        }
    }

    func record(appVersion: String) -> AnalyticsRecord {
        let (name, actionProperties) = fields
        var properties = actionProperties
        properties["platform"] = .string("ios")
        properties["$geoip_disable"] = .bool(true)
        properties["$process_person_profile"] = .bool(false)
        if appVersion.range(of: #"^[0-9A-Za-z.+-]{1,32}$"#, options: .regularExpression) != nil {
            properties["app_version"] = .string(appVersion)
        }
        return AnalyticsRecord(uuid: UUID(), timestamp: Date().ISO8601Format(Date.ISO8601FormatStyle(includingFractionalSeconds: true)),
                               event: name, properties: properties)
    }
}

struct AnalyticsRecord: Codable, Equatable, Sendable {
    let uuid: UUID
    let timestamp: String
    let event: String
    let properties: [String: AnalyticsValue]
}

enum AnalyticsValue: Codable, Equatable, Sendable {
    case string(String), integer(Int), bool(Bool)

    init(from decoder: Decoder) throws {
        let box = try decoder.singleValueContainer()
        if let value = try? box.decode(Bool.self) { self = .bool(value) }
        else if let value = try? box.decode(Int.self) { self = .integer(value) }
        else { self = .string(try box.decode(String.self)) }
    }

    func encode(to encoder: Encoder) throws {
        var box = encoder.singleValueContainer()
        switch self {
        case let .string(value): try box.encode(value)
        case let .integer(value): try box.encode(value)
        case let .bool(value): try box.encode(value)
        }
    }
}

@MainActor
final class ProductAnalytics: ProductTracking {
    static let shared = ProductAnalytics()
    private let delivery: AnalyticsDelivery?
    private let appVersion: String

    private init() {
        let bundle = Bundle.main
        appVersion = bundle.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? ""
        let environment = ProcessInfo.processInfo.environment
        guard let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first else {
            delivery = nil
            return
        }
        #if targetEnvironment(simulator)
        #if DEBUG
        if let target = Self.fixtureEndpoint(environment["TRISTR_TEST_ANALYTICS_URL"]), let port = target.port {
            delivery = AnalyticsDelivery(file: support.appendingPathComponent("TristrFixtureTelemetry/\(port)/events.json"),
                                         endpoint: target, projectToken: "tristr-local-fixture")
            return
        }
        #endif
        delivery = nil
        #else
        guard environment["XCTestConfigurationFilePath"] == nil, NSClassFromString("XCTestCase") == nil,
              let url = bundle.url(forResource: "analytics-project", withExtension: "json"),
              let data = try? Data(contentsOf: url), let token = Self.projectToken(data) else {
            delivery = nil
            return
        }
        delivery = AnalyticsDelivery(file: support.appendingPathComponent("TristrTelemetry/events.json"),
                                     endpoint: URL(string: "https://us.i.posthog.com/batch/")!, projectToken: token)
        #endif
    }

    nonisolated static func projectToken(_ data: Data) -> String? {
        struct Config: Decodable { let projectToken: String }
        guard let value = try? JSONDecoder().decode(Config.self, from: data).projectToken,
              value.range(of: #"^phc_[A-Za-z0-9]{16,128}$"#, options: .regularExpression) != nil else { return nil }
        return value
    }

    nonisolated static func fixtureEndpoint(_ value: String?) -> URL? {
        guard let value, let url = URL(string: value), url.scheme == "http", url.host == "127.0.0.1",
              let port = url.port, (1...65_535).contains(port),
              url.user == nil, url.password == nil, url.query == nil, url.fragment == nil,
              url.path == "/batch" || url.path == "/batch/" else { return nil }
        return url
    }

    func capture(_ event: ProductEvent) {
        delivery?.enqueue(event.record(appVersion: appVersion))
    }
}
