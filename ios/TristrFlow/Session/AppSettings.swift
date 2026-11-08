import Foundation
import Observation

@MainActor
@Observable
final class AppSettings {
    static let speedSteps: [Double] = [0.75, 1, 1.25, 1.5, 1.75, 2, 2.5]

    /// Delivery settings supported by the hosted ElevenLabs voices.
    static let stabilities: [(value: Double, label: String)] = [(0, "Creative"), (0.5, "Natural"), (1, "Robust")]

    @ObservationIgnored private let defaults: UserDefaults
    @ObservationIgnored let analytics: any ProductTracking
    @ObservationIgnored private var initialFontSize: Double?

    var voiceID: String {
        didSet {
            guard voiceID != oldValue else { return }
            defaults.set(voiceID, forKey: "voiceID")
            analytics.capture(.settingChanged(.voice))
        }
    }
    var voiceName: String {
        didSet { defaults.set(voiceName, forKey: "voiceName") }
    }
    var stability: Double {
        didSet {
            guard stability != oldValue else { return }
            defaults.set(stability, forKey: "stability")
            analytics.capture(.settingChanged(.stability))
        }
    }
    var speed: Double {
        didSet {
            guard speed != oldValue else { return }
            defaults.set(speed, forKey: "speed")
            analytics.capture(.settingChanged(.speed))
        }
    }
    var fontSize: Double {
        didSet {
            guard fontSize != oldValue else { return }
            defaults.set(fontSize, forKey: "fontSize")
            if initialFontSize == nil { analytics.capture(.settingChanged(.fontSize)) }
        }
    }
    init(defaults: UserDefaults = .standard, analytics: (any ProductTracking)? = nil) {
        self.defaults = defaults
        self.analytics = analytics ?? ProductAnalytics.shared
        voiceID = defaults.string(forKey: "voiceID") ?? Voice.fallback.id
        voiceName = defaults.string(forKey: "voiceName") ?? Voice.fallback.name
        stability = Self.number(defaults, "stability") ?? 0.5
        speed = Self.number(defaults, "speed") ?? 1
        fontSize = Self.number(defaults, "fontSize") ?? 20
    }

    // A slider gesture can produce many values. Report only a committed change.
    func fontSizeEditingChanged(_ editing: Bool) {
        if editing {
            if initialFontSize == nil { initialFontSize = fontSize }
        } else if let original = initialFontSize {
            initialFontSize = nil
            if fontSize != original { analytics.capture(.settingChanged(.fontSize)) }
        }
    }

    /// `double(forKey:)` also reads values given as launch arguments ("-speed 1"),
    /// which arrive as strings; `object(forKey:) as? Double` would drop them.
    private static func number(_ defaults: UserDefaults, _ key: String) -> Double? {
        defaults.object(forKey: key) == nil ? nil : defaults.double(forKey: key)
    }
}
