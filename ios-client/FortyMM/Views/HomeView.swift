import SwiftUI

/// Home: the topbar's wordmark and account menu over the roadmap. The web's
/// sidebar has only Home in it, so the app has no tab bar.
struct HomeView: View {
    let model: AppModel
    let account: Account
    let signIn: () -> Void

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 48) {
                    if let error = model.signInError {
                        SignInErrorBanner(error: error, tryAgain: signIn) { model.signInError = nil }
                    }
                    RoadmapView()
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 24)
            }
            .background(Color.bgApp)
            .navigationBarTitleDisplayMode(.inline)
            .toolbarBackground(Color.bgPanel, for: .navigationBar)
            .toolbarBackground(.visible, for: .navigationBar)
            .toolbar {
                ToolbarItem(placement: .principal) { Wordmark() }
                ToolbarItem(placement: .topBarTrailing) {
                    AccountMenu(model: model, account: account, signIn: signIn)
                }
            }
        }
    }
}

/// The account menu at the topbar's trailing end. A guest gets Sign in, and
/// Sign out behind a confirmation, because nobody can get a guest account
/// back after it signs out. A verified account signs out at once.
struct AccountMenu: View {
    let model: AppModel
    let account: Account
    let signIn: () -> Void
    @State private var confirmingGuestSignOut = false

    var body: some View {
        Menu {
            Section(headline) {
                Text(account.player.displayName)
            }
            Section {
                if account.kind == .guest {
                    Button("Sign in", systemImage: "person.crop.circle", action: signIn)
                }
                Button(signingOut ? "Signing out…" : "Sign out", systemImage: "rectangle.portrait.and.arrow.right") {
                    if account.kind == .guest {
                        confirmingGuestSignOut = true
                    } else {
                        signOut()
                    }
                }
                .disabled(signingOut)
            }
        } label: {
            // The web hides the name next to the avatar below 600px, so a
            // phone shows the avatar alone.
            PlayerAvatar(player: account.player)
        }
        .accessibilityLabel("Your account")
        .accessibilityValue(account.player.displayName)
        // An alert, as the web's dialog is modal. A confirmation dialog shows
        // as a popover without its cancel button, so Keep playing would hide.
        .alert(
            "Sign out of this guest account?",
            isPresented: $confirmingGuestSignOut
        ) {
            Button("Sign out", role: .destructive, action: signOut)
            Button("Sign in", action: signIn)
            Button("Keep playing", role: .cancel) {}
        } message: {
            Text("A guest account lives only on this device. After you sign out, you can’t get it back, and \(account.player.displayName) stays behind. Sign in first to keep it.")
        }
        .alert(
            "Couldn’t sign you out",
            isPresented: Binding(
                get: { model.signOutState == .failed },
                set: { if !$0 { model.dismissSignOutFailure() } }
            )
        ) {
            Button("Try again", action: signOut)
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Check your connection, then try again.")
        }
    }

    private var headline: String {
        switch account.kind {
        case .guest: "Playing as a guest"
        case .verified(let email): email
        }
    }

    private var signingOut: Bool { model.signOutState == .signingOut }

    private func signOut() {
        Task { await model.signOut() }
    }
}
