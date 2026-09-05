import Foundation

/// The durable home for the session token. The Keychain is the vault; an
/// in-memory copy is the working value used on the request hot path, so we
/// touch the Keychain only on launch (first read) and on changes (writes) —
/// never per request. An actor serialises access so concurrent requests can't
/// race the cache.
actor SessionTokenStore {
    static let shared = SessionTokenStore()

    private let keychain: KeychainStore
    private let endedKey: String
    private var endedFallback: SessionEndReason?
    private var cached: String?
    private var didLoad = false

    /// Set when `cached` holds a token the Keychain write didn't persist — e.g.
    /// a session minted on a background/locked launch, before the device's
    /// first unlock, fails the `kSecAttrAccessibleAfterFirstUnlock`-gated write.
    /// We retry the save on the next access so the token isn't silently lost on
    /// the next cold launch (which would mint a brand-new guest, abandoning this
    /// one's matches and rating).
    private var needsPersist = false

    /// The double-submit CSRF token, captured from the server's non-HttpOnly
    /// `csrf_token` cookie. In-memory only: it isn't a secret, and the API
    /// reissues it on the `/v1/session` bootstrap the app makes on every launch
    /// (see `get_session_endpoint`'s self-heal), so it needn't survive a cold
    /// start in the Keychain the way the session token does.
    private var csrf: String?

    init(keychain: KeychainStore = KeychainStore(account: "session-token")) {
        self.keychain = keychain
        self.endedKey = keychain.service + "." + keychain.account + ".ended"
    }

    /// Load the token from the Keychain into the cache once, on first access.
    private func hydrate() {
        guard !didLoad else { return }
        cached = keychain.load()
        didLoad = true
    }

    /// The current token, lazily hydrated from the Keychain on first access.
    func token() -> String? {
        hydrate()
        retryPersistIfNeeded()
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
        endedFallback = nil
        UserDefaults.standard.removeObject(forKey: endedKey)
        guard token != cached else { return }
        cached = token
        didLoad = true
        needsPersist = !keychain.save(token)
    }

    /// Re-attempt a previously-failed Keychain write. Called from `token()`,
    /// which runs at the start of every request, so once the device is unlocked
    /// the cached token gets persisted on the next request rather than waiting
    /// for a token rotation.
    private func retryPersistIfNeeded() {
        guard needsPersist, let token = cached else { return }
        needsPersist = !keychain.save(token)
    }

    /// Forget the session (sign-out). Clears both the cache and the vault, plus
    /// the companion CSRF token (the server clears its cookie alongside the
    /// session, and a stale CSRF token is useless without the session anyway).
    func clear() {
        endedFallback = nil
        UserDefaults.standard.removeObject(forKey: endedKey)
        cached = nil
        csrf = nil
        needsPersist = false
        didLoad = true
        keychain.delete()
    }

    func endedSession() -> SessionEndReason? {
        if let raw = UserDefaults.standard.string(forKey: endedKey), let data = raw.data(using: .utf8),
           let reason = try? JSONDecoder().decode(SessionEndReason.self, from: data) {
            return reason
        }
        return endedFallback
    }

    func endIfCurrent(_ token: String?, message: String, email: String?) -> Bool {
        hydrate()
        guard cached == token else { return false }
        clear()
        let reason = SessionEndReason(message: message, email: email)
        endedFallback = reason
        if let data = try? JSONEncoder().encode(reason), let raw = String(data: data, encoding: .utf8) {
            UserDefaults.standard.set(raw, forKey: endedKey)
        }
        return true
    }

    /// Clear the session only if `token` is still the one we hold, returning
    /// whether it did. A response that drops the session (the merged-away 401)
    /// belongs to the token the *request* sent; if a newer sign-in has since
    /// replaced it, a stale in-flight request must not wipe the new token or
    /// trigger a sign-out. Hydrate first so the comparison is against the real
    /// stored token, not a not-yet-loaded `nil`.
    func clearIfCurrent(_ token: String?) -> Bool {
        hydrate()
        guard cached == token else { return false }
        clear()
        return true
    }
}


struct SessionEndReason: Codable {
    let message: String
    let email: String?
}
