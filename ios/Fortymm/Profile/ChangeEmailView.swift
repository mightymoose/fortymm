import SwiftUI

/// Sheet for adding or changing the account email (`POST /v1/me/email`). The
/// address is the only way to keep an account beyond the current device, so the
/// flow is: enter email → solve Turnstile → we send a confirmation link → the
/// address is `pending` until the link is opened. A pending change can have its
/// link re-sent from here.
struct ChangeEmailView: View {
    let user: SessionUser
    var onDone: () -> Void

    @EnvironmentObject private var session: SessionStore
    private let service = ProfileService.shared
    @State private var captcha = TurnstileController()

    @State private var value: String
    @State private var touched = false
    @State private var captchaToken: String?
    @State private var serverError: String?
    @State private var notice: String?
    @State private var saving = false
    @State private var resending = false
    @FocusState private var focused: Bool

    init(user: SessionUser, onDone: @escaping () -> Void) {
        self.user = user
        self.onDone = onDone
        _value = State(initialValue: user.pendingEmail ?? user.email ?? "")
    }

    private var displayAddress: String { user.pendingEmail ?? user.email ?? "" }
    private var hasAddress: Bool { user.email != nil || user.pendingEmail != nil }
    private var validation: FieldValidation { ProfileRules.email(value) }
    private var dirty: Bool { value != displayAddress }
    private var canSave: Bool {
        validation.ok && dirty && captchaToken != nil && !saving
    }

    private var displayedError: String? {
        ProfileRules.displayError(validation, serverError: serverError, show: touched)
    }

    var body: some View {
        VStack(spacing: 0) {
            EditorHeader(title: hasAddress ? "Email" : "Add email", onCancel: onDone) {
                EditorActionButton(
                    title: hasAddress ? "Update" : "Add",
                    loading: saving,
                    enabled: canSave
                ) { Task { await save() } }
            }
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    intro
                    field
                    captchaSection
                    if hasAddress { statusCard }
                }
                .padding(.horizontal, 20)
                .padding(.top, 14)
                .padding(.bottom, 28)
            }
        }
        .background(FMColor.ink950.ignoresSafeArea())
        .onAppear { if !hasAddress { focused = true } }
    }

    private var intro: some View {
        Text(
            "We use your email for sign-in and account recovery — nothing else. "
                + "No newsletters, no tracking."
        )
        .font(FMFont.ui(13))
        .foregroundStyle(FMColor.fg3)
        .fixedSize(horizontal: false, vertical: true)
    }

    private var field: some View {
        VStack(alignment: .leading, spacing: 7) {
            Eyebrow("Email address")
            HStack(spacing: 9) {
                Image(systemName: "envelope")
                    .font(.system(size: 15))
                    .foregroundStyle(FMColor.fgMuted)
                TextField(
                    "",
                    text: $value,
                    prompt: Text("you@example.com").foregroundStyle(FMColor.fgMuted)
                )
                .font(FMFont.mono(15))
                .foregroundStyle(FMColor.fg1)
                .focused($focused)
                .keyboardType(.emailAddress)
                .autocorrectionDisabled()
                .textInputAutocapitalization(.never)
                .submitLabel(.done)
                .onChange(of: value) { _, _ in if serverError != nil { serverError = nil } }
            }
            .padding(.horizontal, 12)
            .frame(height: 44)
            .background(FMColor.ink800)
            .fmRoundedBorder(
                radius: FMRadius.md,
                color: displayedError != nil ? FMColor.loss : FMColor.borderSubtle
            )
            if let displayedError {
                Text(displayedError)
                    .font(FMFont.ui(FMFont.xs))
                    .foregroundStyle(FMColor.loss)
            }
        }
    }

    /// The Turnstile widget plus a hint that explains why Save is gated until a
    /// token lands. With the always-passes test key the widget self-solves and
    /// the token arrives within a moment, so the hint is short-lived in dev.
    private var captchaSection: some View {
        VStack(alignment: .leading, spacing: 6) {
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

            if dirty, validation.ok, captchaToken == nil {
                Text("Complete the challenge above to continue.")
                    .font(FMFont.ui(FMFont.xs))
                    .foregroundStyle(FMColor.fgMuted)
            }
        }
    }

    @ViewBuilder
    private var statusCard: some View {
        if user.emailStatus == .verified {
            FMAlert(
                title: "Account claimed.",
                message: "Verified. You can sign in from anywhere — and change this any time; we'll send a fresh link.",
                variant: .success
            )
        } else {
            VStack(alignment: .leading, spacing: 12) {
                FMAlert(
                    title: "Waiting for verification.",
                    message: "Open the link we sent to \(displayAddress) to finish claiming your account.",
                    variant: .warn
                )
                if let notice {
                    Text(notice)
                        .font(FMFont.ui(FMFont.xs))
                        .foregroundStyle(FMColor.win)
                }
                Button { Task { await resend() } } label: {
                    HStack(spacing: 7) {
                        if resending { ProgressView().tint(FMColor.fg1) }
                        Text(resending ? "Resending…" : "Resend link")
                            .font(FMFont.ui(13, weight: .semibold))
                    }
                    .foregroundStyle(captchaToken == nil ? FMColor.fgMuted : FMColor.fg1)
                    .padding(.horizontal, 14)
                    .frame(height: 38)
                    .fmRoundedBorder(radius: FMRadius.md, color: FMColor.borderDefault)
                }
                .buttonStyle(.plain)
                .disabled(resending || captchaToken == nil)
            }
        }
    }

    private func save() async {
        guard validation.ok, dirty else { return }
        guard let token = captchaToken else {
            serverError = "Complete the challenge above to continue."
            return
        }
        serverError = nil
        saving = true
        defer { saving = false }
        do {
            let updated = try await service.setEmail(value, captchaToken: token)
            session.apply(updated)
            onDone()
        } catch {
            resetCaptcha()
            serverError = error.fmMessage
        }
    }

    private func resend() async {
        guard let token = captchaToken else {
            serverError = "Complete the challenge above, then tap Resend."
            return
        }
        notice = nil
        resending = true
        defer { resending = false }
        do {
            let updated = try await service.resendEmailConfirmation(captchaToken: token)
            session.apply(updated)
            resetCaptcha()
            notice = "Verification link re-sent to \(displayAddress)."
        } catch {
            resetCaptcha()
            serverError = error.fmMessage
        }
    }

    /// Clear the spent token and reset the widget so the next attempt mints a
    /// fresh one rather than replaying a now-used (single-use) token.
    private func resetCaptcha() {
        captcha.reset()
        captchaToken = nil
    }
}
