import SwiftUI

struct AccountSwitchGateView: View {
    let change: AccountSwitchPreview?
    var onContinue: () -> Void
    var onCancel: () -> Void

    var body: some View {
        LoginScaffold(
            eyebrow: "Account switch", line1: "Your account.", line2: "Your choice.",
            stepNo: "03", stepLabel: "Confirm account",
            title: change.map { "Continue as \($0.toUsername)?" } ?? "Your sign-in changed",
            subtitle: change.map {
                "You're signed in as \($0.fromUsername). Continuing signs this device in as \($0.toUsername)."
            } ?? "Review this link again before continuing. The link has not been used."
        ) {
            LoginButton(title: change.map { "Continue as \($0.toUsername)" } ?? "Review link", action: onContinue)
            LoginButton(title: "Cancel", kind: .ghost, action: onCancel)
        }
    }
}
