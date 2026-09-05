import Combine
import Foundation

/// Owns the app's session lifecycle. Calling `load()` hits `GET /v1/session`,
/// which mints a guest account on first run and resumes it thereafter.
@MainActor
final class SessionStore: ObservableObject {
    enum State {
        case idle
        case loading
        case loaded(SessionUser)
        /// The cookie's guest was merged into another account (on this or another
        /// device). Route to sign-in with the reason + the owner's email to
        /// prefill — never silently mint a different guest.
        case signedOut(reason: String, email: String?)
        case failed(String)
    }

    @Published private(set) var state: State = .idle

    /// A pending deep link (Universal Link from an emailed sign-in / confirm
    /// link), held until the session has loaded so `RootView` can present the
    /// matching flow over the shell. Cleared once that flow is dismissed.
    @Published var pendingDeepLink: DeepLink?

    /// Delay link POSTs until bootstrap has restored the CSRF companion, while
    /// still allowing a recovery link after bootstrap resolves to signed out.
    var presentedDeepLink: DeepLink? {
        get {
            switch state {
            case .loaded: return pendingDeepLink
            case .signedOut:
                if case .match = pendingDeepLink { return nil }
                return pendingDeepLink
            case .idle, .loading, .failed: return nil
            }
        }
        set { pendingDeepLink = newValue }
    }

    /// Record an opened URL as a pending deep link if it's one we recognise.
    /// Stored rather than acted on directly: a link can arrive at cold launch
    /// before `GET /v1/session` resolves, so `RootView` only presents it once
    /// the shell is up.
    func handle(_ url: URL) {
        if let link = DeepLink(url: url) {
            pendingDeepLink = link
        }
    }

    /// A deep-link flow (sign-in or email confirm) resolved to a session: fold
    /// the user in and clear the pending link so its cover dismisses.
    func resolveDeepLink(_ response: SessionResponse) {
        apply(response.data.user)
        pendingDeepLink = nil
    }

    /// Open a match deep link (a tapped result notification). Held like
    /// any pending link so `RootView` presents it once the shell is up.
    func openMatch(_ id: UUID) {
        pendingDeepLink = .match(id: id)
    }

    /// The signed-in user when the session has resolved, else nil. Lets screens
    /// read the user without re-switching over `state` at every call site.
    var user: SessionUser? {
        if case let .loaded(user) = state { return user }
        return nil
    }

    /// The signed-in username, or nil before the session resolves. A stable
    /// identity handle for screens that need to refetch when the signed-in user
    /// changes (a sign-in/merge flips a guest username to the account's), since
    /// `state` isn't `Equatable` and can't be observed with `.onChange`.
    var username: String? { user?.username }

    private let client: APIClient
    private var cancellables = Set<AnyCancellable>()

    init(client: APIClient = .shared) {
        self.client = client
        // Any request can report the session was merged away (the dead cookie
        // still resolves server-side). Listen globally and route to sign-in.
        NotificationCenter.default
            .publisher(for: APIClient.sessionEndedNotification)
            .receive(on: DispatchQueue.main)
            .sink { [weak self] note in
                let reason = (note.userInfo?["message"] as? String)
                    ?? "Your session has ended. Sign in to continue."
                let email = note.userInfo?["email"] as? String
                Task { @MainActor in self?.signedOut(reason: reason, email: email) }
            }
            .store(in: &cancellables)
    }

    /// Drop into the signed-out state while keeping pending recovery links.
    func signedOut(reason: String, email: String?) {
        // Keep email links: they are how the holder recovers this session.
        // A protected match link must not cover the sign-in screen.
        if case .match = pendingDeepLink { pendingDeepLink = nil }
        state = .signedOut(reason: reason, email: email)
    }

    /// Fold an updated user — returned by a profile mutation (username/email
    /// change) — straight into the loaded state, so the UI reflects the change
    /// without a second `GET /v1/session` round-trip.
    func apply(_ user: SessionUser) {
        state = .loaded(user)
    }

    func startNewGuest() async {
        state = .loading
        do {
            let response = try await client.startNewGuest()
            state = .loaded(response.data.user)
        } catch {
            state = .signedOut(reason: "We couldn't start a new guest. Please try again.", email: nil)
        }
    }

    /// Create or resume the session. Skips the network call if a user is
    /// already loaded, so re-entering the dashboard doesn't refetch.
    func load(force: Bool = false) async {
        if case .loaded = state, !force { return }
        if case .loading = state { return }

        state = .loading
        do {
            let response = try await client.getSession()
            // While this getSession was in flight, a concurrent request may have
            // flipped us to .signedOut (its session was merged away → token
            // cleared → this call ran cookieless and minted a *fresh* guest), or
            // a deep link may have resolved the session. Don't clobber either:
            // only commit if we're still the in-flight load.
            guard case .loading = state else { return }
            state = .loaded(response.data.user)
        } catch let APIError.sessionMerged(message, email) {
            // getSession sends the current token, and APIClient only raises this
            // for a merge of the token it sent — so reaching here means *our*
            // session was merged and signing out is right. Still gate on
            // .loading for symmetry, so a state another task already resolved
            // mid-flight isn't overwritten.
            guard case .loading = state else { return }
            signedOut(reason: message, email: email)
        } catch {
            guard case .loading = state else { return }
            state = .failed(error.fmMessage)
        }
    }
}
