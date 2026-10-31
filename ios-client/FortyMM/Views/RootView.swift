import AuthenticationServices
import SwiftUI

/// Shows the screen for the app's phase, and owns the sign-in sheet.
struct RootView: View {
    let model: AppModel
    @Environment(\.webAuthenticationSession) private var webAuthenticationSession

    var body: some View {
        Group {
            switch model.phase {
            case .starting:
                // The launch screen's wordmark, as the web's loading screen.
                SplashView()
            case .ready(let account):
                HomeView(model: model, account: account, signIn: signIn)
            case .failed(let failure):
                FailureView(failure: failure) { Task { await model.start() } }
            case .signedOut:
                SignedOutView(model: model, signIn: signIn)
            }
        }
        .task { await model.start() }
    }

    private func signIn() {
        Task {
            await model.signIn { url in
                do {
                    // Ephemeral, so iOS asks no "wants to use … to sign in"
                    // question, and no provider cookie outlives the sign-in.
                    // That's also why sign-out needs no provider logout page.
                    return try await webAuthenticationSession.authenticate(
                        using: url,
                        callbackURLScheme: "fortymm",
                        preferredBrowserSession: .ephemeral
                    )
                } catch let error as ASWebAuthenticationSessionError where error.code == .canceledLogin {
                    return nil
                }
            }
        }
    }
}

/// The screen for a session that didn't start.
struct FailureView: View {
    let failure: Failure
    let tryAgain: () -> Void

    var body: some View {
        ErrorScreen(title: failure.title, message: failure.sentence) {
            switch failure {
            case .unreachable:
                Label("The server can take a few seconds to start.", systemImage: "info.circle")
                    .font(.subheadline)
                    .foregroundStyle(Color.fg2)
            case .rateLimited(let retryAt?):
                RetryTime(at: retryAt)
            case .rateLimited(nil), .broken:
                EmptyView()
            }
        } actions: {
            Button("Try again", action: tryAgain).buttonStyle(.primary)
        }
    }
}

/// When a rate-limited person can try again, from the 429's Retry-After.
struct RetryTime: View {
    let at: Date

    var body: some View {
        Label {
            Text("Try again at ") + Text(at, format: .dateTime.hour().minute()).font(.number(size: 14, relativeTo: .subheadline))
        } icon: {
            Image(systemName: "clock")
        }
        .font(.subheadline.weight(.medium))
        .foregroundStyle(Color.rest)
    }
}

/// After sign-out. It starts no session until the person picks one.
struct SignedOutView: View {
    let model: AppModel
    let signIn: () -> Void

    var body: some View {
        ErrorScreen(
            title: "You’re signed out",
            message: "You signed out of FortyMM on this device. Sign in to get back to your players, or play as a guest."
        ) {
            if let error = model.signInError {
                SignInErrorBanner(error: error, tryAgain: signIn) { model.signInError = nil }
                    .multilineTextAlignment(.leading)
            }
        } actions: {
            Button("Sign in", action: signIn)
                .buttonStyle(.primary)
                .disabled(model.signInState == .signingIn)
            Button("Play as a guest") { Task { await model.playAsGuest() } }
                .buttonStyle(.ghost)
        }
    }
}

/// Why a sign-in didn't finish, as the web's `SignInErrorAlert`.
struct SignInErrorBanner: View {
    let error: SignInError
    let tryAgain: () -> Void
    let dismiss: () -> Void

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: error.isError ? "exclamationmark.circle" : "info.circle")
                .foregroundStyle(error.isError ? Color.danger : Color.fg3)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(error.title)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(Color.fg1)
                    .accessibilityAddTraits(.isHeader)
                Text(error.body)
                    .font(.subheadline)
                    .foregroundStyle(Color.fg2)
                HStack(spacing: 8) {
                    Button("Try again", action: tryAgain).buttonStyle(.primary(.small))
                    Button("Dismiss", action: dismiss).buttonStyle(.ghost(.small))
                }
                .padding(.top, 10)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(EdgeInsets(top: 14, leading: 16, bottom: 16, trailing: 16))
        .background(error.isError ? Color.dangerSoft : Color.bgPanel, in: .rect(cornerRadius: 8))
        .overlay {
            RoundedRectangle(cornerRadius: 8)
                .strokeBorder(error.isError ? Color.danger.opacity(0.55) : Color.borderControl)
        }
        .accessibilityElement(children: .contain)
        // An error is announced at once, as the web's role="alert".
        .onAppear { if error.isError { AccessibilityNotification.Announcement(error.title).post() } }
    }
}
