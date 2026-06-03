import Combine
import Foundation

/// Owns the dashboard's data. `load()` fetches the BFF endpoint `GET /v1/dashboard`
/// (all the "Your game" widgets, pre-shaped) alongside `GET /v1/session` for the
/// signed-in username used in the greeting. The two are independent, so they run
/// concurrently.
@MainActor
final class DashboardStore: ObservableObject {
    struct Loaded {
        let username: String
        let dashboard: DashboardResponse
    }

    enum State {
        case idle
        case loading
        case loaded(Loaded)
        case failed(String)
    }

    @Published private(set) var state: State = .idle

    private let client: APIClient

    init(client: APIClient = .shared) {
        self.client = client
    }

    /// Fetch (or refetch) the dashboard. Skips the network call once loaded
    /// unless `force` is set, so re-entering the tab doesn't refetch; pull to
    /// refresh passes `force: true`.
    ///
    /// The two calls are sequenced, not concurrent: `GET /v1/session` is what
    /// mints and stores the guest's session cookie on first launch, and
    /// `GET /v1/dashboard` requires auth — firing them in parallel races the
    /// dashboard ahead of the cookie and 401s. (Mirrors the web client, which
    /// only enables the dashboard query after the session query succeeds.)
    func load(force: Bool = false) async {
        if case .loaded = state, !force { return }
        if case .loading = state { return }

        state = .loading
        do {
            let session = try await client.getSession()
            let dashboard: DashboardResponse = try await client.get("/v1/dashboard")
            state = .loaded(Loaded(username: session.data.user.username, dashboard: dashboard))
        } catch {
            state = .failed(error.fmMessage)
        }
    }
}
