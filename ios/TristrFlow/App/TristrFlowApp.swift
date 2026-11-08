import SwiftUI

@main
struct TristrFlowApp: App {
    @Environment(\.scenePhase) private var scenePhase
    @State private var activity = AppActivity()
    @State private var settings = AppSettings()
    @State private var session: ReadingSession
    @State private var account: AccountSession

    init() {
        let reader = ReadingSession()
        let account = AccountSession()
        account.onSignOut = {
            if reader.isActive { reader.stop() }
        }
        _session = State(initialValue: reader)
        _account = State(initialValue: account)
    }

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environment(settings)
                .environment(session)
                .environment(account)
                .tint(Theme.accent)
        }
        .onChange(of: scenePhase, initial: true) { _, phase in
            if let event = activity.event(for: phase) { ProductAnalytics.shared.capture(event) }
        }
    }
}

/// The App-level scene phase aggregates all windows. Brief interruptions such
/// as Control Center move through inactive without leaving the foreground.
struct AppActivity {
    private enum State { case new, launched, active, background }
    private var state: State = .new

    mutating func event(for phase: ScenePhase) -> ProductEvent? {
        switch (state, phase) {
        case (.new, _):
            state = phase == .active ? .active : .launched
            return .appLaunched
        case (.launched, .active):
            state = .active
            return nil
        case (.background, .active):
            state = .active
            return .appForegrounded
        case (.active, .background):
            state = .background
            return .appBackgrounded
        default:
            return nil
        }
    }
}
