import Foundation
import Security

/// Minimal wrapper over the iOS Keychain for a single secret string. Backs the
/// session token: a generic-password item, device-local (never synced to iCloud
/// Keychain), readable after first unlock so background/locked requests still
/// work. No biometric gate — the guest session is meant to be frictionless.
struct KeychainStore {
    let service: String
    let account: String

    init(
        service: String = Bundle.main.bundleIdentifier ?? "com.fortymm.app",
        account: String
    ) {
        self.service = service
        self.account = account
    }

    /// Persist `value`, returning whether the write succeeded. A write can fail
    /// (e.g. `errSecInteractionNotAllowed` if attempted before the device's
    /// first unlock, given `kSecAttrAccessibleAfterFirstUnlock`); the caller
    /// must not assume the value is durably stored.
    @discardableResult
    func save(_ value: String) -> Bool {
        // Delete any existing item first so SecItemAdd can't fail with
        // errSecDuplicateItem.
        SecItemDelete(baseQuery as CFDictionary)
        var attributes = baseQuery
        attributes[kSecValueData as String] = Data(value.utf8)
        attributes[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
        return SecItemAdd(attributes as CFDictionary, nil) == errSecSuccess
    }

    func load() -> String? {
        var query = baseQuery
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: AnyObject?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
              let data = result as? Data
        else { return nil }
        return String(data: data, encoding: .utf8)
    }

    func delete() {
        SecItemDelete(baseQuery as CFDictionary)
    }

    private var baseQuery: [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
    }
}
