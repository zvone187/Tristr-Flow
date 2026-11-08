import SwiftUI
import XCTest
@testable import TristrFlow

@MainActor
final class AccountSessionTests: XCTestCase {
    func testLifecycleTracksLaunchOnceAndOnlyRealForegroundChanges() {
        var activity = AppActivity()
        let phases: [ScenePhase] = [.inactive, .active, .inactive, .active, .inactive,
                                    .background, .background, .inactive, .active, .active]
        XCTAssertEqual(phases.compactMap { activity.event(for: $0) },
                       [.appLaunched, .appBackgrounded, .appForegrounded])
    }

    func testAnalyticsTracksOnlyCurrentAccountTransitions() async {
        let events = AccountEvents()
        let vault = MemoryVault("saved-token")
        let service = SessionService()
        let account = AccountSession(client: service, vault: vault, analytics: events)
        await account.restore()
        account.invalidate(token: "a-stale-request")
        account.invalidate(token: "saved-token")
        service.loginError = ServiceError.invalidCredentials
        await account.signIn(email: "private@example.org", password: "private-password")
        service.loginError = nil
        await account.signIn(email: "private@example.org", password: "private-password")
        account.signOut()
        account.signOut()
        XCTAssertEqual(events.recorded, [
            .account(action: .restore, outcome: .success),
            .account(action: .expired, outcome: .success),
            .account(action: .login, outcome: .rejected),
            .account(action: .login, outcome: .success),
            .account(action: .logout, outcome: .success),
        ])
    }
    func testLoginStoresBearerAndSignOutRemovesIt() async {
        let vault = MemoryVault()
        let service = SessionService()
        let events = AccountEvents()
        let account = AccountSession(client: service, vault: vault, analytics: events)
        await account.restore()
        XCTAssertEqual(events.recorded, [.account(action: .restore, outcome: .noSession)])
        await account.signIn(email: "  reader@example.org  ", password: " typed password ")
        XCTAssertEqual(service.submittedEmail, "reader@example.org")
        XCTAssertEqual(service.submittedPassword, " typed password ")
        XCTAssertEqual(account.email, "reader@example.org")
        XCTAssertEqual(vault.token, "test-session")
        XCTAssertEqual(account.phase, .signedIn)

        var stopped = false
        account.onSignOut = { stopped = true }
        account.signOut()
        XCTAssertTrue(stopped)
        XCTAssertNil(vault.token)
        XCTAssertNil(account.token)
        XCTAssertNil(account.email)
        XCTAssertEqual(account.phase, .signedOut)
    }

    func testNetworkFailureDuringRestorationPreservesBearerForRetry() async {
        let vault = MemoryVault("saved")
        let service = SessionService()
        service.profile = { _ in throw URLError(.notConnectedToInternet) }
        let events = AccountEvents()
        let account = AccountSession(client: service, vault: vault, analytics: events)
        await account.restore()
        XCTAssertEqual(account.phase, .restoreFailed)
        XCTAssertNil(account.token)
        XCTAssertEqual(vault.token, "saved")

        service.profile = { token in
            XCTAssertEqual(token, "saved")
            return ServiceAccount(email: "reader@example.org", minutesLeft: 8, plan: "free")
        }
        await account.restore()
        XCTAssertEqual(account.phase, .signedIn)
        XCTAssertEqual(account.token, "saved")
        XCTAssertEqual(events.recorded, [.account(action: .restore, outcome: .failed),
                                        .account(action: .restore, outcome: .success)])
    }

    func testUnauthorizedRestorationRemovesOnlyRejectedBearer() async {
        let vault = MemoryVault("expired")
        let service = SessionService()
        service.profile = { _ in throw ServiceError.unauthorized }
        let account = AccountSession(client: service, vault: vault)
        await account.restore()
        XCTAssertEqual(account.phase, .signedOut)
        XCTAssertNil(vault.token)
        await account.signIn(email: "reader@example.org", password: "password")
        account.invalidate(token: "expired")
        XCTAssertEqual(account.token, "test-session")
        account.invalidate(token: "test-session")
        XCTAssertNil(vault.token)
        XCTAssertEqual(account.phase, .signedOut)
    }

    func testLateRestoreCannotUndoSignOut() async {
        let vault = MemoryVault("old")
        let lookupStarted = expectation(description: "Profile lookup started")
        var response: CheckedContinuation<ServiceAccount, Never>?
        let service = SessionService()
        service.profile = { _ in
            await withCheckedContinuation {
                response = $0
                lookupStarted.fulfill()
            }
        }
        let account = AccountSession(client: service, vault: vault)
        let restore = Task { await account.restore() }
        await fulfillment(of: [lookupStarted], timeout: 2)
        account.signOut()
        response?.resume(returning: ServiceAccount(email: "reader@example.org", minutesLeft: 2, plan: "free"))
        await restore.value
        XCTAssertNil(account.token)
        XCTAssertNil(vault.token)
        XCTAssertEqual(account.phase, .signedOut)
    }

    func testLoginFailsClosedWhenBearerCannotBeStored() async {
        let vault = MemoryVault()
        vault.writeError = URLError(.cannotWriteToFile)
        let account = AccountSession(client: SessionService(), vault: vault)
        await account.restore()
        await account.signIn(email: "reader@example.org", password: "password")
        XCTAssertEqual(account.phase, .signedOut)
        XCTAssertNil(account.token)
        XCTAssertNotNil(account.message)
    }

    func testFailedKeychainDeletionLocksReaderUntilSignOutCanFinish() async {
        let vault = MemoryVault("saved")
        let account = AccountSession(client: SessionService(), vault: vault)
        await account.restore()
        vault.clearError = URLError(.cannotWriteToFile)
        account.signOut()
        XCTAssertEqual(account.phase, .signOutFailed)
        XCTAssertNil(account.token)
        await account.restore()
        XCTAssertEqual(account.phase, .signOutFailed)
        vault.clearError = nil
        account.signOut()
        XCTAssertEqual(account.phase, .signedOut)
        XCTAssertNil(vault.token)
    }
}

@MainActor
private final class MemoryVault: TokenVault {
    var token: String?
    var writeError: Error?
    var clearError: Error?
    init(_ token: String? = nil) { self.token = token }
    func read() throws -> String? { token }
    func store(_ token: String) throws {
        if let writeError { throw writeError }
        self.token = token
    }
    func clear() throws {
        if let clearError { throw clearError }
        token = nil
    }
}

@MainActor
private final class SessionService: AccountService {
    var submittedEmail: String?
    var submittedPassword: String?
    var loginError: Error?
    var profile: (String) async throws -> ServiceAccount = { _ in
        ServiceAccount(email: "reader@example.org", minutesLeft: 8, plan: "free")
    }
    func login(email: String, password: String) async throws -> ServiceLogin {
        submittedEmail = email
        submittedPassword = password
        if let loginError { throw loginError }
        return ServiceLogin(email: email, apiToken: "test-session")
    }
    func me(token: String) async throws -> ServiceAccount { try await profile(token) }
}

private final class AccountEvents: ProductTracking {
    private(set) var recorded: [ProductEvent] = []
    func capture(_ event: ProductEvent) { recorded.append(event) }
}
