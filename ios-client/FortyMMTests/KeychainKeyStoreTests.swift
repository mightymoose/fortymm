import CryptoKit
import Foundation
import Testing
@testable import FortyMM

/// The real Keychain. The Simulator has no Secure Enclave, so this checks
/// the software key branch only.
struct KeychainKeyStoreTests {
    let store = KeychainKeyStore(account: "test-\(UUID().uuidString)")

    @Test func keepsTheKeyItMade() throws {
        defer { store.delete() }
        #expect(store.load() == nil)

        let key = try store.create()
        let loaded = try #require(store.load())

        #expect(loaded.publicKey == key.publicKey)
        let message = Data("hello".utf8)
        // The COSE_Key holds x at bytes 8 to 39 and y at 43 to 74.
        let cose = key.publicKey.coseKey
        let publicKey = try P256.Signing.PublicKey(rawRepresentation: cose[8..<40] + cose[43..<75])
        #expect(publicKey.isValidSignature(try .init(rawRepresentation: loaded.sign(message)), for: message))
    }

    @Test func aNewKeyReplacesTheOldOne() throws {
        defer { store.delete() }
        let old = try store.create()

        let new = try store.create()

        #expect(new.publicKey != old.publicKey)
        #expect(store.load()?.publicKey == new.publicKey)
    }

    @Test func forgetsADeletedKey() throws {
        _ = try store.create()

        store.delete()

        #expect(store.load() == nil)
    }

    @Test func keepsOneKeyPerBaseURL() throws {
        let other = KeychainKeyStore(account: "test-\(UUID().uuidString)")
        defer { store.delete(); other.delete() }

        let key = try store.create()

        #expect(other.load() == nil)
        #expect(store.load()?.publicKey == key.publicKey)
    }
}
