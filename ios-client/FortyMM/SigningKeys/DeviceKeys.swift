import Foundation

/// What a device sends to register its key to an account.
struct KeyRegistration: Equatable, Sendable {
    enum Outcome: Equatable, Sendable {
        /// The account has the key now. That includes a key it already had.
        case registered
        /// Another account owns the key.
        case ownedElsewhere
        /// The account reported the device compromised, so the key verifies
        /// nothing.
        case revoked
    }

    /// The key's COSE_Key.
    let publicKey: Data
    let proof: Data
    /// The name the account's device list shows.
    let label: String

    init(key: some MessageSigner, account: UUID, label: String) throws {
        publicKey = key.publicKey.coseKey
        proof = try RegistrationProof.make(account: account, key: key)
        self.label = label
    }
}

/// The device's signing key, and its registration to the session's account.
struct DeviceKeys: Sendable {
    let store: any DeviceKeyStore
    /// The name the account's device list shows, such as "iPhone".
    let label: String

    /// The key the device holds, if any.
    var current: KeyID? { store.load()?.publicKey.kid }

    /// Registers the device's key to `account`, and makes the key first if
    /// the device has none. Every session start calls it, and the API answers
    /// 200 for a key the account already has. So a registration that failed
    /// offline, or a sign-in that moved to another account, needs no state
    /// of its own. The next start registers again. A key that another
    /// account owns can never be this account's, and a revoked key verifies
    /// nothing, so either makes a new one.
    ///
    /// It never fails. The app works offline, and the next start tries again.
    func register(to account: Account, with api: any AccountAPI) async {
        do {
            let key = try store.load() ?? store.create()
            if try await api.registerSigningKey(KeyRegistration(key: key, account: account.id, label: label)) != .registered {
                _ = try await api.registerSigningKey(KeyRegistration(key: try store.create(), account: account.id, label: label))
            }
        } catch {}
    }

    /// Deletes the device's key, after a sign-out told the API.
    func forget() {
        store.delete()
    }
}
