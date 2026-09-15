import SwiftUI

/// The five bottom-nav slots. `newMatch` is an action slot, not a screen —
/// selecting it triggers the new-match flow rather than switching tabs.
enum FMTab: Hashable {
    case home, matches, newMatch, tournaments, profile
}

/// The signed-in app shell. Uses the system `TabView` so the bottom bar is the
/// real iOS tab bar (free safe-area handling, accessibility, the standard look),
/// tinted ball-orange for the active tab. Each screen fills the space above it.
struct MainTabView: View {
    @State private var selection: FMTab = .home
    @State private var showingNewMatch = false
    /// A filter the Matches list should adopt when another tab routes to it
    /// (the dashboard attention panel's "View all" link → the user's matches).
    @State private var matchesFilter: MatchesFilter?

    var body: some View {
        TabView(selection: $selection) {
            DashboardView(onViewAll: { username in
                matchesFilter = MatchesFilter(status: nil, query: username ?? "")
                selection = .matches
            }, isSelected: selection == .home)
                .tabItem { Label("Home", systemImage: "house") }
                .tag(FMTab.home)

            MatchesListView(pendingFilter: $matchesFilter, isSelected: selection == .matches)
                .tabItem { Label("Matches", systemImage: "sportscourt") }
                .tag(FMTab.matches)

            // Action slot — opens the new-match flow via `.onChange`; the bar is
            // snapped off this tab immediately so its empty content never shows.
            Color.clear
                .tabItem { Label("New match", systemImage: "plus") }
                .tag(FMTab.newMatch)

            TournamentsListView(isSelected: selection == .tournaments)
                .tabItem { Label("Tournaments", systemImage: "trophy") }
                .tag(FMTab.tournaments)

            ProfileView()
                .tabItem { Label("You", systemImage: "person.crop.circle") }
                .tag(FMTab.profile)
        }
        .tint(FMColor.ball500)
        .toolbar(.hidden, for: .navigationBar)
        .navigationBarBackButtonHidden(true)
        // "New match" is an action slot, not a destination: open the flow, then
        // snap selection back to the tab we came from (`oldValue`) so the bar
        // never rests on the empty action slot (which left the screen blank).
        .onChange(of: selection) { oldValue, newValue in
            if newValue == .newMatch {
                showingNewMatch = true
                selection = oldValue
            }
        }
        .fullScreenCover(isPresented: $showingNewMatch) {
            MatchFlowView { toMatches in
                showingNewMatch = false
                if toMatches { selection = .matches }
            }
        }
    }
}

#Preview {
    NavigationStack { MainTabView() }
        .preferredColorScheme(.dark)
}
