import Combine
import SwiftUI

/// Destinations reachable from the landing page. Kept tiny on purpose — the
/// dashboard is the only real surface so far.
enum Route: Hashable {
    case dashboard
}

/// Drives the root `NavigationStack`. Landing-page CTAs push onto it via the
/// environment so the scattered, private section views don't each need their
/// own navigation plumbing.
@MainActor
final class Router: ObservableObject {
    @Published var path = NavigationPath()

    func goToDashboard() {
        path.append(Route.dashboard)
    }
}
