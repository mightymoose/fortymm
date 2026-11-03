import CryptoKit
import Foundation
import Security

/// Where the device keeps its signing key between launches.
protocol DeviceKeyStore: Sendable {
    func load() -> SigningKey?
    /// Makes a new key and keeps it in place of any other.
    func create() throws -> SigningKey
    func delete()
}

/// Keeps the key in the Keychain, one item per API base URL, as
/// `KeychainCookieStore` keeps the cookies. A Secure Enclave key never
/// leaves the enclave: the item holds its encrypted handle. The Simulator
/// has no Secure Enclave, so there the item holds a software key.
struct KeychainKeyStore: DeviceKeyStore {
    let account: String

    private enum Kind: String, Codable {
        case secureEnclave
        case software
    }

    private struct Item: Codable {
        let kind: Kind
        let key: Data
    }

    private var query: [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: "com.fortymm.ios-client.signing-key",
            kSecAttrAccount as String: account,
        ]
    }

    func load() -> SigningKey? {
        var query = query
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: AnyObject?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
              let data = result as? Data,
              let item = try? JSONDecoder().decode(Item.self, from: data)
        else { return nil }
        switch item.kind {
        case .secureEnclave:
            return (try? SecureEnclave.P256.Signing.PrivateKey(dataRepresentation: item.key)).map(SigningKey.init(secureEnclave:))
        case .software:
            return (try? P256.Signing.PrivateKey(rawRepresentation: item.key)).map(SigningKey.init(software:))
        }
    }

    func create() throws -> SigningKey {
        let key: SigningKey
        let item: Item
        if SecureEnclave.isAvailable {
            let enclaveKey = try SecureEnclave.P256.Signing.PrivateKey()
            key = SigningKey(secureEnclave: enclaveKey)
            item = Item(kind: .secureEnclave, key: enclaveKey.dataRepresentation)
        } else {
            let softwareKey = P256.Signing.PrivateKey()
            key = SigningKey(software: softwareKey)
            item = Item(kind: .software, key: softwareKey.rawRepresentation)
        }
        let attributes: [String: Any] = [
            kSecValueData as String: try JSONEncoder().encode(item),
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

struct KeychainError: Error {
    let status: OSStatus
}
