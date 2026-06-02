import SwiftUI

/// The signed-in landing surface. For now it does one real thing: create (or
/// resume) the session via `GET /v1/session` and show who you are. Everything
/// else is deliberately left for later.
struct DashboardView: View {
    @StateObject private var session = SessionStore()

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: FMSpace.s6) {
                header
                content
            }
            .padding(.horizontal, FMSpace.s5)
            .padding(.vertical, FMSpace.s6)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .background(FMColor.bgApp.ignoresSafeArea())
        .task { await session.load() }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: FMSpace.s3) {
            FMEyebrow(text: "Dashboard")
            VStack(alignment: .leading, spacing: 0) {
                Text("Welcome to")
                    .foregroundStyle(FMColor.fg1)
                Text("FortyMM.")
                    .foregroundStyle(FMColor.ball500)
            }
            .font(FMFont.display(40))
        }
    }

    @ViewBuilder
    private var content: some View {
        switch session.state {
        case .idle, .loading:
            loadingCard
        case let .loaded(user):
            sessionCard(user)
        case let .failed(message):
            errorCard(message)
        }
    }

    private var loadingCard: some View {
        FMCard {
            HStack(spacing: FMSpace.s3) {
                ProgressView()
                    .tint(FMColor.ball500)
                Text("Creating your session…")
                    .font(FMFont.ui(FMFont.md))
                    .foregroundStyle(FMColor.fg3)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private func sessionCard(_ user: SessionUser) -> some View {
        FMCard(featured: true) {
            VStack(alignment: .leading, spacing: FMSpace.s4) {
                HStack(spacing: FMSpace.s3) {
                    FMAvatar(
                        initials: initials(for: user.username),
                        size: 44,
                        color: FMColor.ball500,
                        foreground: FMColor.fgInverse
                    )
                    VStack(alignment: .leading, spacing: 2) {
                        Text(user.username)
                            .font(FMFont.ui(FMFont.md, weight: .semibold))
                            .foregroundStyle(FMColor.fg1)
                        Text("Signed in")
                            .font(FMFont.mono(FMFont.xs))
                            .foregroundStyle(FMColor.fgMuted)
                    }
                    Spacer()
                    FMBadge(text: badgeText(for: user.emailStatus), variant: .live)
                }

                Rectangle().fill(FMColor.borderSubtle).frame(height: 1)

                Text(statusBlurb(for: user.emailStatus))
                    .font(FMFont.ui(FMFont.sm))
                    .foregroundStyle(FMColor.fg3)
                    .lineSpacing(2)
            }
        }
    }

    private func errorCard(_ message: String) -> some View {
        FMCard {
            VStack(alignment: .leading, spacing: FMSpace.s4) {
                Text("Couldn't start your session")
                    .font(FMFont.ui(FMFont.md, weight: .semibold))
                    .foregroundStyle(FMColor.fg1)
                Text(message)
                    .font(FMFont.ui(FMFont.sm))
                    .foregroundStyle(FMColor.fg3)
                    .lineSpacing(2)
                FMButton(title: "Try again", variant: .primary, size: .md) {
                    Task { await session.load(force: true) }
                }
            }
        }
    }

    private func initials(for username: String) -> String {
        let letters = username
            .split(whereSeparator: { !$0.isLetter && !$0.isNumber })
            .prefix(2)
            .compactMap { $0.first }
        let joined = String(letters).uppercased()
        return joined.isEmpty ? "?" : joined
    }

    private func badgeText(for status: SessionUser.EmailStatus) -> String {
        switch status {
        case .guest: return "Guest"
        case .pending: return "Pending"
        case .verified: return "Verified"
        }
    }

    private func statusBlurb(for status: SessionUser.EmailStatus) -> String {
        switch status {
        case .guest:
            return "You're playing as a guest. Add an email later to keep your matches across devices."
        case .pending:
            return "Check your inbox to confirm your email and lock in your account."
        case .verified:
            return "Your account is verified. Your matches follow you everywhere."
        }
    }
}

#Preview {
    NavigationStack {
        DashboardView()
    }
    .preferredColorScheme(.dark)
}
