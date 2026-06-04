import SwiftUI

/// The five bottom-nav slots. `newMatch` is an action slot, not a screen —
/// selecting it triggers the new-match flow rather than switching tabs.
enum FMTab: Hashable {
    case home, matches, newMatch, tournaments, profile

    /// Title shown in the top bar for the tab.
    var title: String {
        switch self {
        case .home: return "FortyMM"
        case .matches: return "Matches"
        case .newMatch: return "New match"
        case .tournaments: return "Tournaments"
        case .profile: return "You"
        }
    }
}

/// The signed-in app shell. Uses the system `TabView` so the bottom bar is the
/// real iOS tab bar (free safe-area handling, accessibility, the standard look),
/// tinted ball-orange for the active tab. Today only Home is a real screen. The
/// shell owns the single top bar so each tab screen is just its content.
struct MainTabView: View {
    @State private var selection: FMTab = .home
    @State private var showingNewMatch = false

    var body: some View {
        TabView(selection: $selection) {
            DashboardView()
                .tabItem { Label("Home", systemImage: "house") }
                .tag(FMTab.home)

            MatchesListView()
                .tabItem { Label("Matches", systemImage: "sportscourt") }
                .tag(FMTab.matches)

            // Action slot — opens the new-match flow via `.onChange`; the bar is
            // snapped off this tab immediately so its empty content never shows.
            Color.clear
                .tabItem { Label("New match", systemImage: "plus") }
                .tag(FMTab.newMatch)

            FMComingSoon(title: "Tournaments")
                .tabItem { Label("Tournaments", systemImage: "trophy") }
                .tag(FMTab.tournaments)

            FMComingSoon(title: "You")
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
        .safeAreaInset(edge: .top, spacing: 0) {
            FMTopBar(title: selection.title)
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
