import Foundation
import Observation

@MainActor
protocol AccountService {
    func login(email: String, password: String) async throws -> ServiceLogin
    func me(token: String) async throws -> ServiceAccount
}

extension ServiceClient: AccountService {}

@MainActor
@Observable
final class AccountSession {
    enum Phase { case restoring, signedOut, signingIn, signedIn, restoreFailed, signOutFailed }

    private(set) var phase: Phase = .restoring
    private(set) var email: String?
    private(set) var token: String?
    private(set) var message: String?
    @ObservationIgnored var onSignOut: (() -> Void)?
    @ObservationIgnored private let client: any AccountService
    @ObservationIgnored private let vault: any TokenVault
    @ObservationIgnored private let analytics: (any ProductTracking)?
    @ObservationIgnored private var generation = 0

    convenience init() {
        self.init(client: ServiceClient(), vault: KeychainStore(), analytics: ProductAnalytics.shared)
    }

    init(client: any AccountService, vault: any TokenVault, analytics: (any ProductTracking)? = nil) {
        self.client = client
        self.vault = vault
        self.analytics = analytics
    }

    func restore() async {
        guard phase == .restoring || phase == .restoreFailed else { return }
        generation += 1
        let operation = generation
        phase = .restoring
        message = nil
        do {
            guard let saved = try vault.read() else {
                phase = .signedOut
                analytics?.capture(.account(action: .restore, outcome: .noSession))
                return
            }
            let profile = try await client.me(token: saved)
            guard operation == generation else { return }
            token = saved
            email = profile.email
            phase = .signedIn
            analytics?.capture(.account(action: .restore, outcome: .success))
        } catch {
            guard operation == generation else { return }
            if case ServiceError.unauthorized = error {
                analytics?.capture(.account(action: .restore, outcome: .rejected))
                clearSession(expired: true)
            } else {
                phase = .restoreFailed
                message = error.localizedDescription
                analytics?.capture(.account(action: .restore, outcome: .failed))
            }
        }
    }

    func signIn(email input: String, password: String) async {
        let address = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard phase == .signedOut, !address.isEmpty, !password.isEmpty else { return }
        generation += 1
        let operation = generation
        phase = .signingIn
        message = nil
        do {
            let login = try await client.login(email: address, password: password)
            guard operation == generation else { return }
            try vault.store(login.apiToken)
            token = login.apiToken
            email = login.email
            phase = .signedIn
            analytics?.capture(.account(action: .login, outcome: .success))
        } catch {
            guard operation == generation else { return }
            message = error.localizedDescription
            phase = .signedOut
            if case ServiceError.invalidCredentials = error {
                analytics?.capture(.account(action: .login, outcome: .rejected))
            } else {
                analytics?.capture(.account(action: .login, outcome: .failed))
            }
        }
    }

    func invalidate(token rejectedToken: String) {
        guard rejectedToken == token else { return }
        clearSession(expired: true)
    }

    func signOut() {
        guard phase != .signedOut else { return }
        clearSession(expired: false)
    }

    private func clearSession(expired: Bool) {
        generation += 1
        onSignOut?()
        email = nil
        token = nil
        do {
            try vault.clear()
            phase = .signedOut
            message = expired ? "Your sign-in expired. Sign in again." : nil
            analytics?.capture(.account(action: expired ? .expired : .logout, outcome: .success))
        } catch {
            phase = .signOutFailed
            message = "Couldn’t remove your saved sign-in. Unlock your iPhone and tap Sign Out again."
            analytics?.capture(.account(action: expired ? .expired : .logout, outcome: .failed))
        }
    }
}
