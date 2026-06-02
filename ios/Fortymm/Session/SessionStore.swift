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

    private let client: APIClient

    init(client: APIClient = .shared) {
        self.client = client
    }

    var user: SessionUser? {
        if case let .loaded(user) = state { return user }
        return nil
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
            let message = (error as? LocalizedError)?.errorDescription
                ?? error.localizedDescription
            state = .failed(message)
        }
    }
}
