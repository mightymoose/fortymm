import SwiftUI
import UIKit

/// Step 02 — "check your inbox". Confirms where the link went, offers to open
/// Mail or resend, and counts the link's 15-minute life down. Resend re-hits the
/// captcha-gated request endpoint, so it carries its own (compact) Turnstile.
struct CheckInboxView: View {
    let email: String
    var onStartOver: () -> Void

    private let service = LoginService.shared
    @State private var captcha = TurnstileController()

    @State private var captchaToken: String?
    @State private var resending = false
    @State private var notice: String?
    @State private var serverError: String?
    @State private var expiresAt = Date().addingTimeInterval(15 * 60)

    var body: some View {
        LoginScaffold(
            eyebrow: "The ball is in your inbox",
            line1: "Sent.",
            line2: "Go fetch.",
            stepNo: "02",
            stepLabel: "Check inbox",
            title: "Link sent to \(email)",
            subtitle: "A sign-in link is flying toward \(email) right now. Open it on this "
                + "device to log in. Expires in 15 — like a real rally."
        ) {
            VStack(alignment: .leading, spacing: 14) {
                receipt

                HStack(spacing: 10) {
                    LoginButton(title: "Open Mail") { openMail() }
                    LoginButton(title: "Resend", kind: .ghost, loading: resending, fullWidth: false) {
                        Task { await resend() }
                    }
                }

                resendVerification

                if let notice {
                    Text(notice)
                        .font(FMFont.ui(FMFont.xs))
                        .foregroundStyle(FMColor.win)
                } else if let serverError {
                    Text(serverError)
                        .font(FMFont.ui(FMFont.xs))
                        .foregroundStyle(FMColor.loss)
                }

                LoginFineprint {
                    Text("No link? Check spam. Or hit resend — we don't mind.\n")
                        + Text("Wrong address? ").foregroundColor(FMColor.fgMuted)
                        + Text("Start over.").foregroundColor(FMColor.ball500)
                }
                .onTapGesture { onStartOver() }

                ExpiresCountdown(expiresAt: expiresAt)
                    .padding(.top, 4)
            }
        }
    }

    private var receipt: some View {
        ReceiptCard {
            ReceiptRow(key: "To", value: email)
            ReceiptDivider()
            ReceiptRow(key: "Subject", value: "Your FortyMM sign-in link")
            ReceiptDivider()
            ReceiptRow(key: "From", value: "no-reply@fortymm.com", valueColor: FMColor.fg3)
        }
    }

    /// Compact challenge that arms the resend button. With the always-passes test
    /// key it self-solves invisibly; a real key would surface a small widget.
    private var resendVerification: some View {
        TurnstileView(
            controller: captcha,
            onToken: { captchaToken = $0 },
            onExpire: { captchaToken = nil },
            onError: { captchaToken = nil }
        )
        .frame(height: 60)
        .frame(maxWidth: .infinity, alignment: .center)
    }

    private func resend() async {
        guard let token = captchaToken else {
            serverError = "Hang on — finishing the verification check."
            return
        }
        notice = nil
        serverError = nil
        resending = true
        defer { resending = false }
        do {
            _ = try await service.requestLink(email: email, captchaToken: token)
            resetCaptcha()
            expiresAt = Date().addingTimeInterval(15 * 60)
            notice = "New link sent to \(email)."
        } catch {
            resetCaptcha()
            serverError = error.fmMessage
        }
    }

    /// Clear the spent token and reset the widget so the next resend mints a
    /// fresh one (Turnstile tokens are single-use).
    private func resetCaptcha() {
        captcha.reset()
        captchaToken = nil
    }

    private func openMail() {
        guard let url = URL(string: "message://"), UIApplication.shared.canOpenURL(url) else { return }
        UIApplication.shared.open(url)
    }
}

/// "LINK EXPIRES IN mm:ss" with a draining progress bar, ticking once a second.
struct ExpiresCountdown: View {
    let expiresAt: Date
    private let total: TimeInterval = 15 * 60

    var body: some View {
        TimelineView(.periodic(from: .now, by: 1)) { context in
            let remaining = max(0, expiresAt.timeIntervalSince(context.date))
            HStack(spacing: 12) {
                Text("Link expires in")
                    .font(FMFont.mono(10.5))
                    .tracking(1.6)
                    .foregroundStyle(FMColor.fg3)
                    .textCase(.uppercase)
                Text(format(remaining))
                    .font(FMFont.mono(18, weight: .bold))
                    .foregroundStyle(remaining < 60 ? FMColor.loss : FMColor.ball500)
                Spacer()
                progress(fraction: remaining / total)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
            .background(FMColor.bgPanel)
            .fmRoundedBorder(radius: FMRadius.md, color: FMColor.borderSubtle)
        }
    }

    private func progress(fraction: Double) -> some View {
        GeometryReader { geo in
            ZStack(alignment: .leading) {
                Capsule().fill(FMColor.ink700)
                Capsule()
                    .fill(LinearGradient(
                        colors: [FMColor.ball500, FMColor.ball400],
                        startPoint: .leading, endPoint: .trailing
                    ))
                    .frame(width: geo.size.width * max(0, min(1, fraction)))
            }
        }
        .frame(width: 90, height: 4)
    }

    private func format(_ seconds: TimeInterval) -> String {
        let s = Int(seconds.rounded())
        return String(format: "%02d:%02d", s / 60, s % 60)
    }
}
