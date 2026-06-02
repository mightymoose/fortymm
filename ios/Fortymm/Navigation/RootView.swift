import SwiftUI

/// Hosts the app's navigation stack. The landing page is the root; CTAs push
/// the dashboard via the shared `Router` in the environment.
struct RootView: View {
    @StateObject private var router = Router()

    var body: some View {
        NavigationStack(path: $router.path) {
            LandingView()
                .navigationDestination(for: Route.self) { route in
                    switch route {
                    case .dashboard:
                        MainTabView()
                    }
                }
        }
        .environmentObject(router)
    }
}
