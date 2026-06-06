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

    /// Fetch (or refetch) the dashboard. Without `force`, skips the call once
    /// loaded; with `force` (re-entering the tab, pull-to-refresh, or after a
    /// score is posted) it refetches *in place* — the existing content stays on
    /// screen and is swapped only when the new data arrives, so re-appearing the
    /// tab doesn't flash the loading card. A transient forced-refresh failure
    /// keeps the good content rather than replacing it with an error.
    ///
    /// `GET /v1/dashboard` requires auth, but the session gate guarantees the
    /// session cookie is already minted and stored before this screen renders,
    /// so there's no need to fetch the session here first.
    func load(force: Bool = false) async {
        if case .loading = state { return }
        let alreadyLoaded: Bool
        if case .loaded = state { alreadyLoaded = true } else { alreadyLoaded = false }
        if alreadyLoaded && !force { return }

        if !alreadyLoaded { state = .loading }
        do {
            let dashboard: DashboardResponse = try await client.get("/v1/dashboard")
            state = .loaded(dashboard)
        } catch {
            // Only surface the error when there's nothing already on screen;
            // a failed background refresh shouldn't blank a working dashboard.
            if !alreadyLoaded { state = .failed(error.fmMessage) }
        }
    }
}
