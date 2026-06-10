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

    /// Open a match deep link (a tapped confirm/dispute notification). Held like
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

    /// Drop into the signed-out state (merged away). Clears any pending deep
    /// link so its cover doesn't sit over the sign-in screen.
    func signedOut(reason: String, email: String?) {
        pendingDeepLink = nil
        state = .signedOut(reason: reason, email: email)
    }

    /// Fold an updated user — returned by a profile mutation (username/email
    /// change) — straight into the loaded state, so the UI reflects the change
    /// without a second `GET /v1/session` round-trip.
    func apply(_ user: SessionUser) {
        state = .loaded(user)
    }

    /// Create or resume the session. Skips the network call if a user is
    /// already loaded, so re-entering the dashboard doesn't refetch.
    func load(force: Bool = false) async {
        if case .loaded = state, !force { return }
        if case .loading = state { return }

        state = .loading
        do {
            let response = try await client.getSession()
            state = .loaded(response.data.user)
        } catch let APIError.sessionMerged(message, email) {
            signedOut(reason: message, email: email)
        } catch {
            state = .failed(error.fmMessage)
        }
    }
}
