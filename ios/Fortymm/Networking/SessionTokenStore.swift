import Foundation

/// The durable home for the session token. The Keychain is the vault; an
/// in-memory copy is the working value used on the request hot path, so we
/// touch the Keychain only on launch (first read) and on changes (writes) —
/// never per request. An actor serialises access so concurrent requests can't
/// race the cache.
actor SessionTokenStore {
    static let shared = SessionTokenStore()

    private let keychain: KeychainStore
    private var cached: String?
    private var didLoad = false

    init(keychain: KeychainStore = KeychainStore(account: "session-token")) {
        self.keychain = keychain
    }

    /// The current token, lazily hydrated from the Keychain on first access.
    func token() -> String? {
        if !didLoad {
            cached = keychain.load()
            didLoad = true
        }
        return cached
    }

    /// Persist a freshly minted or rotated token. No-op if unchanged, so a
    /// resumed session doesn't rewrite the Keychain on every call.
    func update(_ token: String) {
        guard token != cached else { return }
        cached = token
        didLoad = true
        keychain.save(token)
    }

    /// Forget the session (sign-out). Clears both the cache and the vault.
    func clear() {
        cached = nil
        didLoad = true
        keychain.delete()
    }
}
