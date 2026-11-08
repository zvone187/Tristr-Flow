import Foundation
import Security

@MainActor
protocol TokenVault {
    func read() throws -> String?
    func store(_ token: String) throws
    func clear() throws
}

struct KeychainStore: TokenVault {
    private var query: [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: "ai.pazi.tristrflow",
            kSecAttrAccount as String: "service-session-token",
        ]
    }

    func read() throws -> String? {
        var lookup = query
        lookup[kSecReturnData as String] = true
        lookup[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(lookup as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        try check(status)
        guard let data = result as? Data, let token = String(data: data, encoding: .utf8), !token.isEmpty else {
            throw StorageError()
        }
        return token
    }

    func store(_ token: String) throws {
        let values: [String: Any] = [
            kSecValueData as String: Data(token.utf8),
            // Allow background playback after unlock. Do not migrate the bearer to other devices.
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        let updated = SecItemUpdate(query as CFDictionary, values as CFDictionary)
        if updated == errSecItemNotFound {
            let item = query.merging(values) { _, value in value }
            try check(SecItemAdd(item as CFDictionary, nil))
        } else {
            try check(updated)
        }
    }

    func clear() throws {
        let status = SecItemDelete(query as CFDictionary)
        if status != errSecItemNotFound { try check(status) }
    }

    private func check(_ status: OSStatus) throws {
        guard status == errSecSuccess else { throw StorageError() }
    }

    private struct StorageError: LocalizedError {
        var errorDescription: String? { "Couldn’t access your saved sign-in. Unlock your iPhone and try again." }
    }
}
