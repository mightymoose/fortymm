import SwiftUI

/// The app's entry surface. Resolves the session before rendering anything real:
/// a loading screen shows while `GET /v1/session` is in flight, then the signed-in
/// shell once a user is in hand. The session store is shared with the rest of the
/// app via the environment so no screen has to refetch.
struct RootView: View {
    @StateObject private var session = SessionStore()

    var body: some View {
        content
            .environmentObject(session)
            .task { await session.load() }
    }

    @ViewBuilder
    private var content: some View {
        switch session.state {
        case .idle, .loading:
            LoadingView()
        case .loaded:
            MainTabView()
        case let .failed(message):
            sessionFailedView(message)
        }
    }

    private func sessionFailedView(_ message: String) -> some View {
        VStack(spacing: FMSpace.s5) {
            FMLogo(size: 30)
            VStack(spacing: FMSpace.s2) {
                Text("Couldn't start your session")
                    .font(FMFont.ui(FMFont.md, weight: .semibold))
                    .foregroundStyle(FMColor.fg1)
                Text(message)
                    .font(FMFont.ui(FMFont.sm))
                    .foregroundStyle(FMColor.fg3)
                    .multilineTextAlignment(.center)
                    .lineSpacing(2)
            }
            FMButton(title: "Try again", variant: .primary, size: .md) {
                Task { await session.load(force: true) }
            }
        }
        .padding(.horizontal, FMSpace.s6)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(FMColor.bgApp.ignoresSafeArea())
    }
}
