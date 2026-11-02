import Foundation
import Security

/// Where the device keeps its signing key between launches. It holds at most
/// one key.
protocol DeviceKeyStore: Sendable {
    func load() -> DeviceKey?
    /// Makes a new key and keeps it in place of any other.
    func create() throws -> DeviceKey
    func delete()
}

/// Keeps the key in the Keychain, one item per API base URL, so a dev
/// stack's key is never registered to production. The item never leaves the
/// device, in a backup or otherwise.
struct KeychainDeviceKeyStore: DeviceKeyStore {
    let account: String

    private var query: [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: "com.fortymm.ios-client.signing-key",
            kSecAttrAccount as String: account,
        ]
    }

    func load() -> DeviceKey? {
        var query = query
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: AnyObject?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
              let data = result as? Data,
              let stored = try? JSONDecoder().decode(DeviceKey.Stored.self, from: data)
        else { return nil }
        return try? DeviceKey(stored: stored)
    }

    func create() throws -> DeviceKey {
        let key = try DeviceKey.make()
        let attributes: [String: Any] = [
            kSecValueData as String: try JSONEncoder().encode(key.stored),
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        var status = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if status == errSecItemNotFound {
            status = SecItemAdd(query.merging(attributes) { $1 } as CFDictionary, nil)
        }
        guard status == errSecSuccess else { throw KeychainError(status: status) }
        return key
    }

    func delete() {
        SecItemDelete(query as CFDictionary)
    }
}

struct KeychainError: Error, Equatable {
    let status: OSStatus
}
