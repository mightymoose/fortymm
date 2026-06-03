import Combine
import Foundation

/// Owns the dashboard's data. `load()` fetches the BFF endpoint `GET /v1/dashboard`
/// (all the "Your game" widgets, pre-shaped). The session — and the username used
/// in the greeting — is resolved up front by `RootView` and read from the shared
/// `SessionStore`, so this store doesn't refetch it.
@MainActor
final class DashboardStore: ObservableObject {
    enum State {
        case idle
        case loading
        case loaded(DashboardResponse)
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
    /// `GET /v1/dashboard` requires auth, but the session gate guarantees the
    /// session cookie is already minted and stored before this screen renders,
    /// so there's no need to fetch the session here first.
    func load(force: Bool = false) async {
        if case .loaded = state, !force { return }
        if case .loading = state { return }

        state = .loading
        do {
            let dashboard: DashboardResponse = try await client.get("/v1/dashboard")
            state = .loaded(dashboard)
        } catch {
            state = .failed(error.fmMessage)
        }
    }
}
