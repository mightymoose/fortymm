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

    /// The fetch currently on the wire, if any — the store's one-request-at-a-time
    /// latch. See `load(force:)`.
    private var inFlight: Task<Void, Never>?

    init(client: APIClient = .shared) {
        self.client = client
    }

    /// Fetch (or refetch) the dashboard. Without `force`, skips the call once
    /// loaded; with `force` (re-entering the tab, pull-to-refresh, a realtime
    /// hint, or after a score is posted) it refetches *in place* — the existing
    /// content stays on screen and is swapped only when the new data arrives, so
    /// re-appearing the tab doesn't flash the loading card. A transient
    /// forced-refresh failure keeps the good content rather than replacing it
    /// with an error.
    ///
    /// **At most one `/v1/dashboard` is ever outstanding.** The `.loading` state
    /// is deliberately *not* entered on an in-place refresh (that is what keeps
    /// content on screen), so state alone can't serve as the in-flight guard on
    /// the forced path — and that path is now push-driven by realtime hints,
    /// which arrive as fast as the broker's 250ms coalesce window allows. So the
    /// running fetch is held here and a new forced load **cancels and replaces**
    /// it rather than racing it: a hint means "what you have is stale", so the
    /// answer worth waiting for is the newest request's, not the one already on
    /// the wire. (The web client gets this for free — TanStack's
    /// `invalidateQueries` defaults to `cancelRefetch: true`.)
    ///
    /// A cancelled fetch touches `state` on no path, so being superseded is
    /// invisible: no blank, no spinner, no error card.
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

        inFlight?.cancel()
        let task = Task {
            do {
                let dashboard: DashboardResponse = try await self.client.get("/v1/dashboard")
                // Superseded while in flight: the replacement is already on the
                // wire with fresher data, so this answer is dropped rather than
                // written and then overwritten.
                guard !Task.isCancelled else { return }
                self.state = .loaded(dashboard)
            } catch {
                // A cancellation isn't a failure — it's this fetch being
                // replaced by a newer one.
                guard !Task.isCancelled else { return }
                // Only surface the error when there's nothing already on screen;
                // a failed background refresh shouldn't blank a working dashboard.
                if !alreadyLoaded { self.state = .failed(error.fmMessage) }
            }
        }
        inFlight = task
        // Callers await the fetch they asked for (pull-to-refresh holds its
        // spinner on this), including when it is the one that gets cancelled.
        await task.value
        // Identity-checked so a superseded fetch finishing late can't clear its
        // own successor's latch.
        if inFlight == task { inFlight = nil }
    }
}
