import SwiftUI

/// The email-confirmation landing — the iOS counterpart to the web app's
/// `/confirm-email` page. A Universal Link from the "confirm your email" message
/// opens it (see `Navigation/DeepLink.swift`); it redeems the token
/// (`POST /v1/me/email/confirm`) and resolves to one of four terminal states:
/// confirmed, superseded by a newer resend, link expired/used, or server
/// unreachable.
///
/// Built on the same `LoginScaffold` / receipt primitives as `VerifyLoginView`
/// so the two emailed-link landings read as one flow. Unlike `VerifyLoginView`
/// (which lives inside `LoginFlowView`'s chrome), this is presented on its own,
/// so it carries its own close header.
struct ConfirmEmailView: View {
    let token: String
    /// Called with the confirmed session so the caller can fold it into
    /// `SessionStore` and dismiss.
    var onConfirmed: (SessionResponse) -> Void
    /// Dismiss without a confirmed session (close button, or after a dead link).
    var onClose: () -> Void

    private let service = ProfileService.shared
    private let loginService = LoginService.shared

    private enum Phase {
        case verifying
        case gate(MergePreview)
        case accountSwitch(AccountSwitchPreview?)
        case success(SessionResponse)
        case expired
        case replaced
        case unreachable
    }
    @State private var phase: Phase = .verifying
    @State private var approvedSwitch: String?
    @State private var pendingMerge: MergePreview?
    @State private var chosenSkipMerge = false
    @State private var submission = LinkSubmission()

    var body: some View {
        VStack(spacing: 0) {
            LoginCloseHeader(onClose: close)
            content
        }
        .background(LoginBackground())
        .interactiveDismissDisabled()
        .task { await start() }
    }

    private func close() {
        Task { await submission.close(onClose) }
    }

    @ViewBuilder
    private var content: some View {
        switch phase {
        case .verifying: verifying
        case let .accountSwitch(change):
            AccountSwitchGateView(change: change, onContinue: {
                approvedSwitch = change?.fromUserId
                if change == nil { Task { await start() } }
                else if let merge = pendingMerge { phase = .gate(merge) }
                else { Task { await confirm(skipMerge: chosenSkipMerge) } }
            }, onCancel: close)
        case let .gate(preview):
            MergeGateView(
                preview: preview,
                onBringThemOver: { Task { await confirm(skipMerge: false) } },
                onNotNow: { Task { await confirm(skipMerge: true) } }
            )
        case let .success(response): success(response)
        case .expired: expired
        case .replaced: replaced
        case .unreachable: unreachable
        }
    }

    // MARK: Verifying

    private var verifying: some View {
        LoginScaffold(
            eyebrow: "Confirming email",
            line1: "Hold up.",
            line2: "Confirming your email.",
            stepNo: "03",
            stepLabel: "Verifying link",
            title: "Confirming your email",
            subtitle: "Just a sec — locking in your address."
        ) {
            VStack(alignment: .leading, spacing: 14) {
                ReceiptCard(tint: FMColor.ball500.opacity(0.6), glow: true) {
                    ReceiptHeader(
                        badge: { LoginSpinner() },
                        eyebrow: "● VERIFYING TOKEN",
                        eyebrowColor: FMColor.ball500,
                        title: "Confirming your new email address…"
                    )
                }
                SolverLog(lines: [
                    .init(status: "200", method: "POST", path: "/email/confirm", note: "token ok"),
                    .init(status: "…", method: "···", path: "/email/commit", note: "stamping address…"),
                ])
            }
        }
    }

    // MARK: Success

    private func success(_ response: SessionResponse) -> some View {
        let user = response.data.user
        let moved = response.merged?.matchesMoved ?? 0
        return LoginScaffold(
            eyebrow: "You're in",
            eyebrowColor: FMColor.serve500,
            line1: "You're in.",
            line2: "Email verified.",
            accent: FMColor.serve500,
            stepNo: "04",
            stepLabel: "Email verified",
            title: "Email confirmed",
            subtitle: "Your email is verified. Your FortyMM account is now yours to keep."
        ) {
            VStack(alignment: .leading, spacing: 14) {
                ReceiptCard(tint: FMColor.serve500.opacity(0.6), glow: true) {
                    ReceiptHeader(
                        badge: { StatusBadge(kind: .success) },
                        eyebrow: "● EMAIL CONFIRMED",
                        eyebrowColor: FMColor.serve500,
                        title: "@\(user.username)"
                    )
                    ReceiptDivider()
                    ReceiptRow(
                        key: "Email",
                        value: user.email ?? "verified",
                        valueColor: FMColor.fg2
                    )
                    if moved > 0 {
                        ReceiptDivider()
                        ReceiptRow(
                            key: "Matches",
                            value: "\(moved) brought with you",
                            valueColor: FMColor.serve500
                        )
                    }
                }
                LoginButton(title: "Enter FortyMM") { onConfirmed(response) }
            }
        }
    }

    // MARK: Expired / used

    private var expired: some View {
        LoginScaffold(
            eyebrow: "Net out",
            eyebrowColor: FMColor.loss,
            line1: "That one missed.",
            line2: "Try again.",
            accent: FMColor.loss,
            stepNo: "!!",
            stepLabel: "Link invalid",
            title: "This link can't be used",
            subtitle: "Your confirmation link expired or was already used. Open your profile "
                + "and re-send the confirmation to get a fresh one."
        ) {
            VStack(alignment: .leading, spacing: 14) {
                ReceiptCard(tint: FMColor.loss.opacity(0.6), glow: true) {
                    ReceiptHeader(
                        badge: { StatusBadge(kind: .failure) },
                        eyebrow: "● TOKEN REJECTED",
                        eyebrowColor: FMColor.loss,
                        title: "Link expired or already used"
                    )
                    ReceiptDivider()
                    ReceiptRow(key: "Fix", value: "Re-send from your profile", valueColor: FMColor.fg2)
                }
                LoginButton(title: "Back to FortyMM") { close() }
            }
        }
    }

    // MARK: Superseded by a newer resend

    /// A newer resend replaced this link. Deliberately NOT the "re-send from
    /// your profile" advice the expired screen gives: resending now would kill
    /// the newer link this screen points to (#1616). The fix it names is
    /// opening the most recent email — which may be addressed to a different
    /// inbox, since the resend goes to whatever address was pending when it
    /// was requested.
    private var replaced: some View {
        LoginScaffold(
            eyebrow: "Net out",
            eyebrowColor: FMColor.warn,
            line1: "Superseded.",
            line2: "Use the newest email.",
            accent: FMColor.warn,
            stepNo: ">>",
            stepLabel: "Link replaced",
            title: "A newer link was sent",
            subtitle: "A newer confirmation email has gone out since this link, "
                + "so this one is no longer live. Open the most recent email we "
                + "sent you — it may be for a different address."
        ) {
            VStack(alignment: .leading, spacing: 14) {
                ReceiptCard(tint: FMColor.warn.opacity(0.6), glow: true) {
                    ReceiptHeader(
                        badge: { StatusBadge(kind: .failure) },
                        eyebrow: "● TOKEN SUPERSEDED",
                        eyebrowColor: FMColor.warn,
                        title: "Replaced by a newer link"
                    )
                    ReceiptDivider()
                    ReceiptRow(
                        key: "Fix",
                        value: "Open the most recent email",
                        valueColor: FMColor.fg2
                    )
                }
                LoginButton(title: "Back to FortyMM") { close() }
            }
        }
    }

    // MARK: Server unreachable

    private var unreachable: some View {
        LoginScaffold(
            eyebrow: "Off the table",
            eyebrowColor: FMColor.loss,
            line1: "Lost signal.",
            line2: "Retry.",
            accent: FMColor.loss,
            stepNo: "03",
            stepLabel: "Verifying · failed",
            title: "Couldn't reach the server",
            subtitle: "We couldn't talk to the server. Check your connection — your link is "
                + "still valid for the next few minutes."
        ) {
            VStack(alignment: .leading, spacing: 14) {
                ReceiptCard(tint: FMColor.loss.opacity(0.6), glow: true) {
                    ReceiptHeader(
                        badge: { StatusBadge(kind: .failure) },
                        eyebrow: "● ERR_NETWORK_UNREACHABLE",
                        eyebrowColor: FMColor.loss,
                        title: "Couldn't reach the server"
                    )
                }
                HStack(spacing: 10) {
                    LoginButton(title: "Retry") { Task { await start() } }
                    LoginButton(title: "Close", kind: .ghost, fullWidth: false) { close() }
                }
            }
        }
    }

    // MARK: Confirm

    /// Preview the link first; a merge that would carry matches over waits at
    /// the gate, everything else confirms straight away.
    private func start() async {
        await submission.run {
            approvedSwitch = nil
            phase = .verifying
            do {
                let preview = try await loginService.mergePreview(token: token)
                pendingMerge = !chosenSkipMerge && preview.isMerge && preview.guestMatchesCount > 0 ? preview : nil
                if let change = preview.accountSwitch {
                    phase = .accountSwitch(change)
                } else if let merge = pendingMerge {
                    phase = .gate(merge)
                } else {
                    await finalize(skipMerge: chosenSkipMerge)
                }
            } catch {
                phase = .unreachable
            }
        }
    }

    private func confirm(skipMerge: Bool) async {
        await submission.run { await finalize(skipMerge: skipMerge) }
    }

    private func finalize(skipMerge: Bool) async {
        chosenSkipMerge = skipMerge
        pendingMerge = nil
        phase = .verifying
        do {
            phase = .success(
                try await service.confirmEmail(token: token, skipMerge: skipMerge, switchFromUserId: approvedSwitch)
            )
        } catch LoginConsumeError.accountSwitchRequired(let change) {
            approvedSwitch = nil
            phase = .accountSwitch(change)
        } catch LoginConsumeError.replaced {
            // A newer resend superseded this link — opening the most recent
            // email is the fix; resending would kill that newer link (#1616).
            phase = .replaced
        } catch LoginConsumeError.rejected {
            // Invalid / expired / already-used link — terminal.
            phase = .expired
        } catch {
            // 5xx / timeout / offline — the still-valid link is worth a retry.
            phase = .unreachable
        }
    }
}
