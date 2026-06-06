import SwiftUI

/// The signed-in home surface. Shows the "Your game" widgets — the current
/// rating card (with sparkline) and the recent-matches table — fed by the BFF
/// endpoint `GET /v1/dashboard`. Mirrors the web dashboard's "Your game" row.
///
/// The session is resolved up front by `RootView` and shared through the
/// environment, so the greeting reads the username from there rather than
/// refetching it.
struct DashboardView: View {
    /// Most "Score needed" banners to show inline before collapsing the rest
    /// into a "+N more" link (mirrors the web's primary + secondary + more).
    private static let maxBanners = 2

    @EnvironmentObject private var session: SessionStore
    @StateObject private var store = DashboardStore()
    var service: MatchService = .shared
    /// Called by the "+N more" banner overflow link to send the user to the
    /// Matches tab, filtered to their live (score-needed) matches. The argument
    /// is the current username, used as the list's search filter. Nil in previews.
    var onShowAllScores: ((String?) -> Void)? = nil

    /// Non-nil while the resume-scoring flow is presented over the dashboard;
    /// `resumeLoading` covers the brief fetch of the full match (the banner
    /// carries only the id, opponent, and current game number).
    @State private var resuming: ResumeScoring?
    @State private var resumeLoading = false

    private static let longDate: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "EEEE, MMMM d"   // e.g. "Wednesday, June 3"
        return f
    }()

    var body: some View {
        ZStack {
            ScrollView {
                VStack(alignment: .leading, spacing: FMSpace.s6) {
                    header(greeting: greeting)
                    content
                }
                .padding(.horizontal, FMSpace.s5)
                // Top inset for the shell's frosted bar is reserved by `.fmTopBar`.
                .padding(.bottom, FMSpace.s6)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .background(FMColor.bgApp.ignoresSafeArea())
            .refreshable { await store.load(force: true) }
            // onAppear (not task) so returning to the Home tab after posting /
            // resuming a match re-fetches — clearing a stale "Score needed"
            // banner and refreshing recent results. force: true silently
            // refreshes in place once content is loaded.
            .onAppear { Task { await store.load(force: true) } }
            // Returning to the foreground may surface cross-device changes (a
            // match the other player just confirmed) — refetch in place.
            .refetchOnForeground { Task { await store.load(force: true) } }

            if resumeLoading { FMBlockingSpinner() }
        }
        // The match just changed (result posted / games entered) — refetch so the
        // score banner clears and the recent results update.
        .resumeScoringCover($resuming) { Task { await store.load(force: true) } }
    }

    /// Fetch the full match behind a score banner and open the resume flow.
    /// Falls back silently if the match can no longer be scored.
    private func openResume(_ matchId: UUID) {
        guard !resumeLoading else { return }
        resumeLoading = true
        Task {
            let detail = try? await service.matchDetails(matchId)
            resumeLoading = false
            if let ctx = detail?.resumeContext { resuming = ctx }
        }
    }

    @ViewBuilder
    private var content: some View {
        switch store.state {
        case .idle, .loading:
            loadingCard
        case let .loaded(dashboard):
            yourGame(dashboard)
        case let .failed(message):
            errorCard(message)
        }
    }

    /// The greeting reads the username from the session `RootView` already
    /// resolved; it falls back to a bare "Hi" only if the session somehow isn't
    /// loaded (it always is by the time this screen renders).
    private var greeting: String {
        if case let .loaded(user) = session.state { return "Hi, @\(user.username)" }
        return "Hi"
    }

    /// The signed-in username, used to filter the matches list when the user
    /// taps "+N more to score". Nil if the session isn't resolved.
    private var currentUsername: String? {
        if case let .loaded(user) = session.state { return user.username }
        return nil
    }

    private func header(greeting: String) -> some View {
        VStack(alignment: .leading, spacing: FMSpace.s2) {
            DashOverline(text: "Dashboard · \(Self.longDate.string(from: Date()))")
            (Text(greeting).foregroundStyle(FMColor.fg1)
                + Text(".").foregroundStyle(FMColor.ball500))
                .font(FMFont.ui(FMFont.xl2, weight: .bold))
        }
    }

    @ViewBuilder
    private func yourGame(_ data: DashboardResponse) -> some View {
        VStack(alignment: .leading, spacing: FMSpace.s4) {
            // Top-priority: matches stranded mid-scoring that need the user to
            // finish entering a result (issue #445). Mirrors the web dashboard's
            // "Score needed" banners — capped so a backlog of stranded matches
            // doesn't bury the rest of the dashboard; the overflow link sends the
            // user to the Matches tab to work through the rest.
            ForEach(data.scoreBanners.prefix(Self.maxBanners), id: \.matchId) { banner in
                ScoreNeededBanner(banner: banner) { openResume(banner.matchId) }
            }
            if data.scoreBanners.count > Self.maxBanners {
                MorePendingLink(count: data.scoreBanners.count - Self.maxBanners) {
                    onShowAllScores?(currentUsername)
                }
            }

            HStack(alignment: .firstTextBaseline, spacing: FMSpace.s3) {
                Text("Your game")
                    .font(FMFont.ui(FMFont.md, weight: .semibold))
                    .foregroundStyle(FMColor.fg1)
                Text(yourGameSubtitle(data.rating))
                    .font(FMFont.ui(FMFont.sm))
                    .foregroundStyle(FMColor.fgMuted)
                Spacer()
            }

            if let rating = data.rating {
                DashboardRatingCard(rating: rating)
            } else {
                FMCard {
                    VStack(alignment: .leading, spacing: FMSpace.s3) {
                        DashOverline(text: "Current rating")
                        Text("Not in a rated league yet.")
                            .font(FMFont.ui(FMFont.sm))
                            .foregroundStyle(FMColor.fg3)
                    }
                }
            }

            DashboardRecentResultsCard(rows: data.recentResults)
        }
    }

    private func yourGameSubtitle(_ rating: DashboardRating?) -> String {
        guard let rating else { return "Last 30 days" }
        return "\(rating.strategyLabel) · last 30 days"
    }

    private var loadingCard: some View {
        FMCard {
            HStack(spacing: FMSpace.s3) {
                ProgressView()
                    .tint(FMColor.ball500)
                Text("Loading your dashboard…")
                    .font(FMFont.ui(FMFont.md))
                    .foregroundStyle(FMColor.fg3)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private func errorCard(_ message: String) -> some View {
        FMCard {
            VStack(alignment: .leading, spacing: FMSpace.s4) {
                Text("Couldn't load your dashboard")
                    .font(FMFont.ui(FMFont.md, weight: .semibold))
                    .foregroundStyle(FMColor.fg1)
                Text(message)
                    .font(FMFont.ui(FMFont.sm))
                    .foregroundStyle(FMColor.fg3)
                    .lineSpacing(2)
                FMButton(title: "Try again", variant: .primary, size: .md) {
                    Task { await store.load(force: true) }
                }
            }
        }
    }
}

/// Dashboard banner for a match stranded mid-scoring — a one-tap path back into
/// score entry so a Live match the user owns is never permanently stranded
/// (issue #445). Mirrors the web dashboard's "Score needed" banner.
private struct ScoreNeededBanner: View {
    let banner: DashboardScoreBanner
    let onResume: () -> Void

    var body: some View {
        FMCard(featured: true) {
            HStack(alignment: .center, spacing: FMSpace.s4) {
                VStack(alignment: .leading, spacing: FMSpace.s1) {
                    HStack(spacing: 7) {
                        Circle().fill(FMColor.ball500).frame(width: 7, height: 7)
                            .shadow(color: FMColor.ball500.opacity(0.55), radius: 5)
                        DashOverline(text: "Score needed")
                    }
                    Text(opponentLine)
                        .font(FMFont.ui(FMFont.md, weight: .semibold))
                        .foregroundStyle(FMColor.fg1)
                        .lineLimit(1)
                    Text("Game \(banner.currentGameNumber) is waiting on a score.")
                        .font(FMFont.ui(FMFont.sm))
                        .foregroundStyle(FMColor.fg3)
                        .lineLimit(1)
                }
                Spacer(minLength: FMSpace.s3)
                FMButton(title: "Enter score", variant: .primary, size: .sm, action: onResume)
            }
        }
    }

    private var opponentLine: String {
        if let opponent = banner.opponentUsername { return "vs @\(opponent)" }
        return "Solo match"
    }
}

/// Overflow link shown under the capped score banners — "+N more to score" —
/// routing the user to the Matches tab to clear the rest.
private struct MorePendingLink: View {
    let count: Int
    let onTap: () -> Void

    var body: some View {
        Button(action: onTap) {
            HStack(spacing: FMSpace.s2) {
                Text("+\(count) more to score")
                    .font(FMFont.ui(FMFont.sm, weight: .semibold))
                    .foregroundStyle(FMColor.fgAccent)
                Image(systemName: "arrow.right")
                    .font(.system(size: 12, weight: .bold))
                    .foregroundStyle(FMColor.fgAccent)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, FMSpace.s1)
            .padding(.vertical, FMSpace.s1)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}

#Preview {
    DashboardView()
        .environmentObject(SessionStore())
        .preferredColorScheme(.dark)
}
