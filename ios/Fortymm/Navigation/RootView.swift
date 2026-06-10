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
            // Universal Links land here (cold launch or while running). The
            // store parses + holds the link; the cover below presents it once
            // the session has loaded.
            .onOpenURL { session.handle($0) }
    }

    @ViewBuilder
    private var content: some View {
        switch session.state {
        case .idle, .loading:
            LoadingView()
        case .loaded:
            MainTabView()
                .fullScreenCover(item: $session.pendingDeepLink) { link in
                    deepLinkDestination(link)
                }
                // Now that a session exists to attach the device token to, ask
                // for notification permission and register with APNs, and route
                // a tapped match notification to its detail. Runs once the
                // signed-in shell appears.
                .task {
                    PushNotificationManager.shared.onOpenMatch = { id in
                        Task { @MainActor in session.openMatch(id) }
                    }
                    PushNotificationManager.shared.requestAuthorizationAndRegister()
                }
        case let .signedOut(reason, email):
            SessionEndedView(
                reason: reason,
                email: email,
                onSignedIn: { session.resolveDeepLink($0) },
                onContinueAsGuest: { Task { await session.load(force: true) } }
            )
        case let .failed(message):
            sessionFailedView(message)
        }
    }

    /// The flow a tapped email link opens. Both fold the resolved session back
    /// into the store (no refetch) and clear the pending link to dismiss the
    /// cover.
    @ViewBuilder
    private func deepLinkDestination(_ link: DeepLink) -> some View {
        switch link {
        case let .login(token):
            LoginFlowView(
                start: .verifying(token: token),
                onClose: { session.pendingDeepLink = nil },
                onSignedIn: { session.resolveDeepLink($0) }
            )
        case let .confirmEmail(token):
            ConfirmEmailView(
                token: token,
                onConfirmed: { session.resolveDeepLink($0) },
                onClose: { session.pendingDeepLink = nil }
            )
        case let .match(id):
            MatchDetailLoaderView(
                matchId: id,
                onClose: { session.pendingDeepLink = nil }
            )
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
