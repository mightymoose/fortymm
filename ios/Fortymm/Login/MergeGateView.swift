import SwiftUI

/// Cross-device confirm gate: shown before folding a guest's matches into the
/// account being signed into, so foreign matches are never imported without the
/// owner's say-so. Shared by the sign-in (`VerifyLoginView`) and email-confirm
/// (`ConfirmEmailView`) landings — only the finalize action differs, passed as a
/// closure. Only rendered when there are matches to carry.
struct MergeGateView: View {
    let preview: MergePreview
    var onBringThemOver: () -> Void
    var onNotNow: () -> Void

    var body: some View {
        let count = preview.guestMatchesCount
        let matchLabel = count == 1 ? "1 match" : "\(count) matches"
        let from = preview.guestUsername.map { "@\($0)" } ?? "your guest session"
        return LoginScaffold(
            eyebrow: "Bring your matches",
            eyebrowColor: FMColor.serve500,
            line1: "Bring your",
            line2: "matches over?",
            accent: FMColor.serve500,
            stepNo: "03",
            stepLabel: "Confirm merge",
            title: "Bring your matches over?",
            subtitle: "Signing in as @\(preview.ownerUsername ?? "your account"). "
                + "We can bring the \(matchLabel) from \(from) into this account."
        ) {
            VStack(alignment: .leading, spacing: 14) {
                ReceiptCard(tint: FMColor.serve500.opacity(0.6), glow: true) {
                    ReceiptHeader(
                        badge: { StatusBadge(kind: .success) },
                        eyebrow: "● BRING MATCHES",
                        eyebrowColor: FMColor.serve500,
                        title: "\(matchLabel) from \(from)"
                    )
                }
                LoginButton(title: "Bring them over", action: onBringThemOver)
                LoginButton(
                    title: "Not now — just sign me in",
                    kind: .ghost,
                    action: onNotNow
                )
            }
        }
    }
}
