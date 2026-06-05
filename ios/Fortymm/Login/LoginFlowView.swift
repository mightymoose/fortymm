import SwiftUI

/// Drives the magic-link sign-in flow: email entry → check inbox, and (once a
/// link can open the app) the verify → signed-in / expired landing. Presented
/// modally; reports the resolved session back so the caller can fold it into
/// `SessionStore`.
struct LoginFlowView: View {
    /// Where the flow begins. `.verifying` is the deep-link entry — wire it to a
    /// universal-link handler later; `.email` is the in-app entry used today
    /// (optionally prefilled, e.g. with the owner's email after a session merge).
    enum Start {
        case email(prefill: String = "")
        case verifying(token: String)
    }

    var onClose: () -> Void
    var onSignedIn: (SessionResponse) -> Void

    private enum Step {
        case email(prefill: String)
        case sent(email: String)
        case verifying(token: String)
    }
    @State private var step: Step

    init(
        start: Start = .email(),
        onClose: @escaping () -> Void,
        onSignedIn: @escaping (SessionResponse) -> Void
    ) {
        self.onClose = onClose
        self.onSignedIn = onSignedIn
        switch start {
        case let .email(prefill):
            _step = State(initialValue: .email(prefill: prefill))
        case let .verifying(token):
            _step = State(initialValue: .verifying(token: token))
        }
    }

    var body: some View {
        VStack(spacing: 0) {
            LoginCloseHeader(onClose: onClose)
            content
        }
        .background(LoginBackground())
    }

    @ViewBuilder
    private var content: some View {
        switch step {
        case let .email(prefill):
            SignInView(initialEmail: prefill) { sentTo in step = .sent(email: sentTo) }
        case let .sent(email):
            CheckInboxView(email: email) { step = .email(prefill: "") }
        case let .verifying(token):
            VerifyLoginView(
                token: token,
                onSignedIn: onSignedIn,
                onRestart: { step = .email(prefill: "") }
            )
        }
    }
}
