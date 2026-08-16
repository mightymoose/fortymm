import SwiftUI

/// The "You" tab: an account hub showing your identity and email-claim status,
/// with entry points into the username and email editors. The shell lays its
/// frosted top bar over this screen (`.fmTopBar`), so this is just the content.
/// The editors are presented as sheets — the app's modal idiom for focused
/// sub-tasks (matching the new-match flow's full-screen cover).
struct ProfileView: View {
    @EnvironmentObject private var session: SessionStore

    private enum Editor: Identifiable {
        case username, email
        var id: Int { hashValue }
    }
    @State private var editor: Editor?
    @State private var showingSignIn = false

    var body: some View {
        ScrollView {
            if let user = session.user {
                content(for: user)
            } else {
                // RootView only shows the shell once the session is loaded, so
                // this is a defensive fallback rather than an expected state.
                ProgressView()
                    .tint(FMColor.ball500)
                    .frame(maxWidth: .infinity)
                    .padding(.top, 80)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(FMColor.bgApp.ignoresSafeArea())
        .sheet(item: $editor) { which in
            sheet(for: which)
                .presentationDragIndicator(.visible)
        }
        .fullScreenCover(isPresented: $showingSignIn) {
            LoginFlowView(
                onClose: { showingSignIn = false },
                onSignedIn: { response in
                    session.apply(response.data.user)
                    showingSignIn = false
                }
            )
        }
    }

    @ViewBuilder
    private func content(for user: SessionUser) -> some View {
        VStack(alignment: .leading, spacing: 20) {
            identity(user)
            if user.emailStatus != .verified {
                claimBanner(user)
            }
            VStack(spacing: 10) {
                SettingRow(
                    icon: "at",
                    label: "Username",
                    value: "@\(user.username)"
                ) { editor = .username }
                SettingRow(
                    icon: "envelope",
                    label: "Email",
                    value: emailRowValue(user),
                    valueTint: emailRowTint(user)
                ) { editor = .email }
            }
            if user.emailStatus != .verified {
                signInRow
            }
        }
        .padding(.horizontal, 20)
        .padding(.top, 4)
        .padding(.bottom, 28)
    }

    /// Entry into the magic-link sign-in flow. Shown for guests/pending users —
    /// signing into an existing account brings their guest matches along.
    private var signInRow: some View {
        Button { showingSignIn = true } label: {
            HStack(spacing: 10) {
                Image(systemName: "person.badge.key")
                    .font(.system(size: 15, weight: .semibold))
                Text("Already have an account? Sign in")
                    .font(FMFont.ui(14, weight: .semibold))
                Spacer()
                Image(systemName: "arrow.right")
                    .font(.system(size: 13, weight: .bold))
            }
            .foregroundStyle(FMColor.ball500)
            .padding(.horizontal, 16)
            .frame(height: 52)
            .background(FMColor.bgAccentSoft)
            .fmRoundedBorder(radius: FMRadius.md, color: FMColor.ball500.opacity(0.4))
        }
        .buttonStyle(.plain)
        .padding(.top, 2)
    }

    private func identity(_ user: SessionUser) -> some View {
        HStack(spacing: 14) {
            FMAvatar(initials: user.username.fmInitials, size: 52)
            VStack(alignment: .leading, spacing: 5) {
                Text("@\(user.username)")
                    .font(FMFont.ui(18, weight: .bold))
                    .foregroundStyle(FMColor.fg1)
                    .lineLimit(1)
                    // Distinct from the "Username" settings row below, which
                    // renders the same "@username" text — a label query would
                    // ambiguously match both. Tagged for the #1180 XCUITest,
                    // which reads the freshly-minted guest's own username off
                    // this screen.
                    .accessibilityIdentifier("profile.identity.username")
                statusBadge(user.emailStatus)
            }
            Spacer()
        }
    }

    @ViewBuilder
    private func statusBadge(_ status: SessionUser.EmailStatus) -> some View {
        switch status {
        case .verified:
            FMBadge(text: "Verified", variant: .live, icon: nil)
        case .pending:
            FMBadge(text: "Pending", variant: .outline)
        case .guest:
            FMBadge(text: "Guest", variant: .primary)
        }
    }

    private func claimBanner(_ user: SessionUser) -> some View {
        Button { editor = .email } label: {
            FMAlert(
                title: user.emailStatus == .guest
                    ? "You're playing as a guest."
                    : "Check your inbox.",
                message: user.emailStatus == .guest
                    ? "Add an email so we don't lose your ratings if you change devices."
                    : "Open the link we sent to \(user.pendingEmail ?? user.email ?? "your inbox") to finish claiming your account.",
                variant: user.emailStatus == .guest ? .info : .warn
            )
        }
        .buttonStyle(.plain)
    }

    @ViewBuilder
    private func sheet(for editor: Editor) -> some View {
        switch editor {
        case .username:
            ChangeUsernameView(current: session.user?.username ?? "") {
                self.editor = nil
            }
            .environmentObject(session)
        case .email:
            if let user = session.user {
                ChangeEmailView(user: user) { self.editor = nil }
                    .environmentObject(session)
            }
        }
    }

    private func emailRowValue(_ user: SessionUser) -> String {
        user.pendingEmail ?? user.email ?? "Not set"
    }

    private func emailRowTint(_ user: SessionUser) -> Color {
        switch user.emailStatus {
        case .verified: return FMColor.fg2
        case .pending: return FMColor.warn
        case .guest: return FMColor.fgMuted
        }
    }
}

/// A tappable settings row: leading icon, label, current value, chevron.
private struct SettingRow: View {
    let icon: String
    let label: String
    let value: String
    var valueTint: Color = FMColor.fg3
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 14) {
                Image(systemName: icon)
                    .font(.system(size: 16, weight: .medium))
                    .foregroundStyle(FMColor.fg3)
                    .frame(width: 22)
                Text(label)
                    .font(FMFont.ui(15, weight: .semibold))
                    .foregroundStyle(FMColor.fg1)
                Spacer()
                Text(value)
                    .font(FMFont.mono(13))
                    .foregroundStyle(valueTint)
                    .lineLimit(1)
                    .truncationMode(.middle)
                Image(systemName: "chevron.right")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(FMColor.fgMuted)
            }
            .padding(.horizontal, 16)
            .frame(height: 56)
            .background(FMColor.bgCard)
            .fmRoundedBorder(radius: FMRadius.md, color: FMColor.borderSubtle)
        }
        .buttonStyle(.plain)
    }
}

/// Shared header for the editor sheets: a Cancel button, a centered title, and
/// a trailing action (the Save/Update button). Mirrors the frosted top-bar look
/// without depending on the tab shell's `FMTopBar`.
struct EditorHeader<Trailing: View>: View {
    let title: String
    let onCancel: () -> Void
    @ViewBuilder let trailing: Trailing

    var body: some View {
        ZStack {
            Text(title)
                .font(FMFont.ui(FMFont.md, weight: .bold))
                .foregroundStyle(FMColor.fg1)
            HStack {
                Button(action: onCancel) {
                    Text("Cancel")
                        .font(FMFont.ui(15, weight: .medium))
                        .foregroundStyle(FMColor.fg3)
                }
                .buttonStyle(.plain)
                Spacer()
                trailing
            }
        }
        .padding(.horizontal, 16)
        .frame(height: 56)
        .frame(maxWidth: .infinity)
        .background(FMColor.ink900)
        .overlay(alignment: .bottom) {
            Rectangle().fill(FMColor.borderSubtle).frame(height: 1)
        }
    }
}

/// The pill-shaped primary action in an editor sheet's header: a spinner while
/// the request is in flight, dimmed when disabled. Shared by both editors so
/// the save/update button is defined once.
struct EditorActionButton: View {
    let title: String
    let loading: Bool
    let enabled: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Group {
                if loading {
                    ProgressView().tint(FMColor.fgInverse)
                } else {
                    Text(title).font(FMFont.ui(14, weight: .bold))
                }
            }
            .foregroundStyle(enabled ? FMColor.fgInverse : FMColor.fgMuted)
            .frame(height: 34)
            .padding(.horizontal, 16)
            .background(enabled ? FMColor.ball500 : FMColor.ink800)
            .clipShape(Capsule())
        }
        .buttonStyle(.plain)
        .disabled(!enabled)
    }
}

#Preview {
    ProfileView()
        .environmentObject(SessionStore())
        .preferredColorScheme(.dark)
}
