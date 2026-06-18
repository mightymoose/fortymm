import SwiftUI

/// Step 01 — email entry. Collects an address, runs the Turnstile challenge
/// (the request endpoint is captcha-gated like the web flow), and requests a
/// magic sign-in link. On success it hands the address up so the flow can show
/// the "check your inbox" screen.
struct SignInView: View {
    var onSent: (String) -> Void

    private let service = LoginService.shared
    @State private var captcha = TurnstileController()

    @State private var email: String
    @State private var touched = false
    @State private var captchaToken: String?
    @State private var serverError: String?
    @State private var sending = false
    @FocusState private var focused: Bool

    init(initialEmail: String = "", onSent: @escaping (String) -> Void) {
        self.onSent = onSent
        _email = State(initialValue: initialEmail)
    }

    private var validation: FieldValidation { ProfileRules.email(email) }
    private var invalid: Bool { serverError != nil || (touched && !validation.ok) }
    private var canSend: Bool { validation.ok && captchaToken != nil && !sending }

    var body: some View {
        LoginScaffold(
            eyebrow: "No passwords · No bullshit · No tracking",
            line1: "Show us",
            line2: "your serve.",
            stepNo: "01",
            stepLabel: "Sign in",
            title: "Your email",
            subtitle: "Drop your email. We send a one-tap link — open it and you're in. "
                + "We never made a password, so we can't lose yours."
        ) {
            VStack(alignment: .leading, spacing: 14) {
                LoginEmailField(text: $email, valid: validation.ok, invalid: invalid, focused: $focused)
                    .onChange(of: email) { _, _ in if serverError != nil { serverError = nil } }

                TurnstileView(
                    controller: captcha,
                    onToken: { token in
                        captchaToken = token
                        if serverError != nil { serverError = nil }
                    },
                    onExpire: { captchaToken = nil },
                    onError: { captchaToken = nil }
                )
                .frame(height: 72)
                .frame(maxWidth: .infinity, alignment: .center)

                if let serverError {
                    Text(serverError)
                        .font(FMFont.ui(FMFont.xs))
                        .foregroundStyle(FMColor.loss)
                } else if validation.ok, captchaToken == nil {
                    Text("Complete the challenge above to send your link.")
                        .font(FMFont.ui(FMFont.xs))
                        .foregroundStyle(FMColor.fgMuted)
                }

                LoginButton(title: "Send the link", loading: sending, enabled: canSend) {
                    Task { await send() }
                }

                LoginDivider(label: "OR")

                LoginFineprint {
                    Text("New here? Same flow — we'll create your account when you confirm.")
                        + Text("\nBy signing in you agree to play fair. That's it.")
                        .foregroundColor(FMColor.fgMuted)
                }
            }
        }
        .onAppear { focused = true }
    }

    private func send() async {
        guard validation.ok else { touched = true; return }
        guard let token = captchaToken else {
            serverError = "Complete the challenge above to continue."
            return
        }
        serverError = nil
        sending = true
        defer { sending = false }
        do {
            let sentTo = try await service.requestLink(email: email, captchaToken: token)
            onSent(sentTo)
        } catch {
            resetCaptcha()
            serverError = error.fmMessage
        }
    }

    /// Clear the spent token and reset the widget so the next attempt mints a
    /// fresh one (Turnstile tokens are single-use).
    private func resetCaptcha() {
        captcha.reset()
        captchaToken = nil
    }
}
