import SwiftUI

/// Shown when the caller's guest session was merged into another account (on
/// this or another device). Rather than silently mint a different guest, we
/// explain what happened and offer to sign in (email prefilled) or start over as
/// a fresh guest. Mirrors the web app's redirect-to-login-with-a-flash.
struct SessionEndedView: View {
    let reason: String
    let email: String?
    /// Folded back into `SessionStore` after a successful sign-in.
    var onSignedIn: (SessionResponse) -> Void
    /// Start fresh as a new guest (the dead cookie was already cleared).
    var onContinueAsGuest: () -> Void

    @State private var showSignIn = false

    var body: some View {
        VStack(spacing: FMSpace.s5) {
            FMLogo(size: 30)
            VStack(spacing: FMSpace.s2) {
                Text("Signed out")
                    .font(FMFont.ui(FMFont.md, weight: .semibold))
                    .foregroundStyle(FMColor.fg1)
                Text(reason)
                    .font(FMFont.ui(FMFont.sm))
                    .foregroundStyle(FMColor.fg3)
                    .multilineTextAlignment(.center)
                    .lineSpacing(2)
            }
            VStack(spacing: FMSpace.s3) {
                FMButton(title: "Sign in", variant: .primary, size: .md) {
                    showSignIn = true
                }
                FMButton(title: "Continue as guest", variant: .ghost, size: .md) {
                    onContinueAsGuest()
                }
            }
        }
        .padding(.horizontal, FMSpace.s6)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(FMColor.bgApp.ignoresSafeArea())
        .fullScreenCover(isPresented: $showSignIn) {
            LoginFlowView(
                start: .email(prefill: email ?? ""),
                onClose: { showSignIn = false },
                onSignedIn: { response in
                    showSignIn = false
                    onSignedIn(response)
                }
            )
        }
    }
}
