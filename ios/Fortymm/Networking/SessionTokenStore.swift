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

    /// The double-submit CSRF token, captured from the server's non-HttpOnly
    /// `csrf_token` cookie. In-memory only: it isn't a secret, and the API
    /// reissues it on the `/v1/session` bootstrap the app makes on every launch
    /// (see `get_session_endpoint`'s self-heal), so it needn't survive a cold
    /// start in the Keychain the way the session token does.
    private var csrf: String?

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

    /// The current CSRF token to echo back on mutating requests, or nil before
    /// the session bootstrap has captured one.
    func csrfToken() -> String? { csrf }

    /// Capture the CSRF token from a `Set-Cookie`. No Keychain write — it lives
    /// only for the process lifetime.
    func updateCSRF(_ value: String) { csrf = value }

    /// Persist a freshly minted or rotated token. No-op if unchanged, so a
    /// resumed session doesn't rewrite the Keychain on every call.
    func update(_ token: String) {
        guard token != cached else { return }
        cached = token
        didLoad = true
        keychain.save(token)
    }

    /// Forget the session (sign-out). Clears both the cache and the vault, plus
    /// the companion CSRF token (the server clears its cookie alongside the
    /// session, and a stale CSRF token is useless without the session anyway).
    func clear() {
        cached = nil
        csrf = nil
        didLoad = true
        keychain.delete()
    }
}
