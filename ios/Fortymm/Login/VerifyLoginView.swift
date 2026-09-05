import SwiftUI

/// Step 03+ — the magic-link landing. Redeems the token (`/v1/login/consume`)
/// and resolves to one of three terminal states: signed in, link expired/used,
/// or server unreachable.
///
/// This screen's only trigger is the user tapping the emailed link, which today
/// opens Safari rather than the app — so it stays dormant until universal-link
/// handling is added. It's fully wired now: feed it a token via `LoginFlowView`
/// and it runs end-to-end. Built ahead so wiring the deep link later is a
/// one-liner.
struct VerifyLoginView: View {
    let token: String
    var onSignedIn: (SessionResponse) -> Void
    var onRestart: () -> Void
    var onClose: () -> Void

    private let service = LoginService.shared

    private enum Phase {
        case verifying
        case gate(MergePreview)
        case accountSwitch(AccountSwitchPreview?)
        case success(SessionResponse)
        case expired
        case unreachable
    }
    @State private var phase: Phase = .verifying
    @State private var approvedSwitch: String?
    @State private var pendingMerge: MergePreview?
    @State private var chosenSkipMerge = false
    @State private var submission = LinkSubmission()

    var body: some View {
        Group {
            switch phase {
            case .verifying: verifying
        case let .accountSwitch(change):
            AccountSwitchGateView(change: change, onContinue: {
                approvedSwitch = change?.fromUserId
                if change == nil { Task { await start() } }
                else if let merge = pendingMerge { phase = .gate(merge) }
                else { Task { await verify(skipMerge: chosenSkipMerge) } }
            }, onCancel: onClose)
            case let .gate(preview):
                MergeGateView(
                    preview: preview,
                    onBringThemOver: { Task { await verify(skipMerge: false) } },
                    onNotNow: { Task { await verify(skipMerge: true) } }
                )
            case let .success(response): success(response)
            case .expired: expired
            case .unreachable: unreachable
            }
        }
        .task { await start() }
    }

    // MARK: Verifying

    private var verifying: some View {
        LoginScaffold(
            eyebrow: "Checking the score",
            line1: "Hold up.",
            line2: "Reading your link.",
            stepNo: "03",
            stepLabel: "Verifying link",
            title: "Confirming your sign-in",
            subtitle: "Just a sec — confirming you're you."
        ) {
            VStack(alignment: .leading, spacing: 14) {
                ReceiptCard(tint: FMColor.ball500.opacity(0.6), glow: true) {
                    ReceiptHeader(
                        badge: { LoginSpinner() },
                        eyebrow: "● VERIFYING TOKEN",
                        eyebrowColor: FMColor.ball500,
                        title: "Confirming signature & expiry…"
                    )
                }
                SolverLog(lines: [
                    .init(status: "200", method: "POST", path: "/auth/verify", note: "signature ok"),
                    .init(status: "200", method: "GET", path: "/auth/session", note: "device match"),
                    .init(status: "…", method: "···", path: "/auth/grant", note: "minting session…"),
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
            line1: "Welcome back,",
            line2: "@\(user.username).",
            accent: FMColor.serve500,
            stepNo: "04",
            stepLabel: "Signed in",
            title: "Account verified",
            subtitle: "Warming up the courts."
        ) {
            VStack(alignment: .leading, spacing: 14) {
                ReceiptCard(tint: FMColor.serve500.opacity(0.6), glow: true) {
                    ReceiptHeader(
                        badge: { StatusBadge(kind: .success) },
                        eyebrow: "● SESSION OPENED",
                        eyebrowColor: FMColor.serve500,
                        title: "@\(user.username)"
                    )
                    ReceiptDivider()
                    ReceiptRow(
                        key: "Account",
                        value: user.email ?? "guest",
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
                LoginButton(title: "Enter FortyMM") { onSignedIn(response) }
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
            subtitle: "Your link expired or was already used. Links are good for 15 minutes "
                + "and a single tap — strict for a reason. We'll send a fresh one."
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
                    ReceiptRow(key: "Lifetime", value: "15 min · single use")
                    ReceiptDivider()
                    ReceiptRow(key: "Fix", value: "Request a fresh link", valueColor: FMColor.fg2)
                }
                LoginButton(title: "Send a new link") { onRestart() }
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
            subtitle: "We couldn't talk to the auth server. Check your connection — your link "
                + "is still valid for the next few minutes."
        ) {
            VStack(alignment: .leading, spacing: 14) {
                ReceiptCard(tint: FMColor.loss.opacity(0.6), glow: true) {
                    ReceiptHeader(
                        badge: { StatusBadge(kind: .failure) },
                        eyebrow: "● ERR_NETWORK_UNREACHABLE",
                        eyebrowColor: FMColor.loss,
                        title: "auth.fortymm.com is unreachable"
                    )
                }
                SolverLog(lines: [
                    .init(status: "200", method: "POST", path: "/auth/verify", note: "signature ok"),
                    .init(status: "…", method: "GET", path: "/auth/session", note: "connecting…"),
                    .init(status: "522", method: "GET", path: "/auth/session", note: "origin unreachable"),
                    .init(status: "ERR", method: "···", path: "/auth/session", note: "gave up after 12s"),
                ])
                HStack(spacing: 10) {
                    LoginButton(title: "Retry") { Task { await start() } }
                    LoginButton(title: "Send a new link", kind: .ghost, fullWidth: false) { onRestart() }
                }
            }
        }
    }

    // MARK: Consume

    /// Preview the link first; a merge that would carry matches over waits at
    /// the gate, everything else signs in straight away.
    private func start() async {
        approvedSwitch = nil
        phase = .verifying
        do {
            let preview = try await service.mergePreview(token: token)
            pendingMerge = !chosenSkipMerge && preview.isMerge && preview.guestMatchesCount > 0 ? preview : nil
            if let change = preview.accountSwitch {
                phase = .accountSwitch(change)
            } else if let merge = pendingMerge {
                phase = .gate(merge)
            } else {
                await verify(skipMerge: chosenSkipMerge)
            }
        } catch {
            phase = .unreachable
        }
    }

    private func verify(skipMerge: Bool) async {
        await submission.run {
            chosenSkipMerge = skipMerge
            pendingMerge = nil
            phase = .verifying
            do {
                phase = .success(
                    try await service.consume(token: token, skipMerge: skipMerge, switchFromUserId: approvedSwitch)
                )
            } catch LoginConsumeError.accountSwitchRequired(let change) {
                approvedSwitch = nil
                phase = .accountSwitch(change)
            } catch LoginConsumeError.rejected {
                phase = .expired
            } catch {
                // Unreachable (or any other transient failure) — offer a retry.
                phase = .unreachable
            }
        }
    }
}
