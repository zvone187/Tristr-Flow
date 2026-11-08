import SwiftUI

struct ContentView: View {
    @Environment(ReadingSession.self) private var session
    @Environment(AppSettings.self) private var settings
    @Environment(AccountSession.self) private var account
    @State private var draft = ""
    @State private var showingSettings = false

    var body: some View {
        NavigationStack {
            Group {
                switch account.phase {
                case .restoring:
                    ProgressView("Checking your sign-in…")
                case .restoreFailed, .signOutFailed:
                    ContentUnavailableView {
                        Label("Account unavailable", systemImage: "person.crop.circle.badge.exclamationmark")
                    } description: {
                        Text(account.message ?? "Try connecting again.")
                    } actions: {
                        if account.phase == .restoreFailed {
                            Button("Retry") { Task { await account.restore() } }
                                .buttonStyle(.borderedProminent)
                        }
                        Button("Sign Out") { account.signOut() }
                    }
                case .signedOut, .signingIn:
                    SignInView()
                case .signedIn:
                    if session.isActive {
                        ReaderScreen(onRetry: read, onOpenSettings: { showingSettings = true })
                    } else {
                        ComposeView(draft: $draft, onRead: read)
                    }
                }
            }
            .background(Theme.background.ignoresSafeArea())
            .navigationTitle("Tristr Flow")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                if account.phase == .signedIn && session.isActive {
                    ToolbarItem(placement: .topBarLeading) {
                        Button("Edit") { session.stop() }
                            .accessibilityIdentifier("editText")
                    }
                }
                if account.phase == .signedIn {
                    ToolbarItem(placement: .topBarTrailing) {
                        Button { showingSettings = true } label: { Image(systemName: "gearshape") }
                            .accessibilityLabel("Settings")
                            .accessibilityIdentifier("settings")
                    }
                }
            }
            .sheet(isPresented: $showingSettings) { SettingsView() }
        }
        .task { await account.restore() }
        .onChange(of: screenEvent, initial: true) { _, event in
            if let event { ProductAnalytics.shared.capture(event) }
        }
        .onChange(of: account.phase) { old, new in
            guard old == .signedIn, new != .signedIn else { return }
            showingSettings = false
            draft = ""
        }
    }

    private var screenEvent: ProductEvent? {
        switch account.phase {
        case .signedOut, .signingIn:
            return .screenViewed(.signIn)
        case .signedIn:
            if showingSettings { return .screenViewed(.settings) }
            return .screenViewed(session.isActive ? .reader : .compose)
        case .restoring, .restoreFailed, .signOutFailed:
            return nil
        }
    }

    private func read() {
        guard let token = account.token else { return }
        session.start(text: draft, settings: settings, token: token, onUnauthorized: { account.invalidate(token: $0) })
    }
}

/// The text with the karaoke highlight, plus the transport controls.
struct ReaderScreen: View {
    @Environment(ReadingSession.self) private var session
    @Environment(AppSettings.self) private var settings
    let onRetry: () -> Void
    let onOpenSettings: () -> Void

    var body: some View {
        VStack(spacing: 0) {
            if case .failed(let message) = session.phase {
                ContentUnavailableView {
                    Label("Couldn't read this aloud", systemImage: "exclamationmark.triangle")
                } description: {
                    Text(message)
                } actions: {
                    Button("Try again", action: onRetry).buttonStyle(.borderedProminent).tint(Theme.accent)
                    Button("Settings", action: onOpenSettings)
                }
                .accessibilityIdentifier("failure")
            } else if let timeline = session.timeline {
                ReaderTextView(
                    timeline: timeline,
                    currentWord: session.currentWord,
                    generatedWords: session.generatedWords,
                    followToken: session.followToken,
                    fontSize: settings.fontSize,
                    onTapWord: { session.seek(toWord: $0) }
                )
                ControlBar()
            }
        }
    }
}
