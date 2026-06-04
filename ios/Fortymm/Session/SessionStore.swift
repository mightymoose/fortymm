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
        case failed(String)
    }

    @Published private(set) var state: State = .idle

    /// The signed-in user when the session has resolved, else nil. Lets screens
    /// read the user without re-switching over `state` at every call site.
    var user: SessionUser? {
        if case let .loaded(user) = state { return user }
        return nil
    }

    private let client: APIClient

    init(client: APIClient = .shared) {
        self.client = client
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
        } catch {
            state = .failed(error.fmMessage)
        }
    }
}
