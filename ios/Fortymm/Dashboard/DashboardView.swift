import SwiftUI

/// The signed-in home surface. Shows the "Your game" widgets — the current
/// rating card (with sparkline) and the recent-matches table — fed by the BFF
/// endpoint `GET /v1/dashboard`. Mirrors the web dashboard's "Your game" row.
///
/// The session is resolved up front by `RootView` and shared through the
/// environment, so the greeting reads the username from there rather than
/// refetching it.
struct DashboardView: View {
    @EnvironmentObject private var session: SessionStore
    @StateObject private var store = DashboardStore()
    var service: MatchService = .shared
    /// Called by the attention panel's "View all" footer link to send the user
    /// to the Matches tab, filtered to their matches. The argument is the
    /// current username, used as the list's search filter. Nil in previews.
    var onViewAll: ((String?) -> Void)? = nil
    /// Whether Home is the currently-selected tab (derived by `MainTabView` from
    /// the `TabView` selection it owns). Drives `.refetchWhenSelected` so tab-return
    /// refetch rides the deterministic selection change rather than `.onAppear`,
    /// which fires unreliably on `TabView` tab-return (ADR 0010).
    var isSelected: Bool = false

    /// Non-nil while the resume-scoring flow is presented over the dashboard;
    /// `resumeLoading` covers the brief fetch of the full match (the attention
    /// row carries only the id, opponent, and current game number).
    @State private var resuming: ResumeScoring?
    @State private var resumeLoading = false
    /// Non-nil while a match-detail screen is presented over the dashboard —
    /// the destination for `review`/`dispute` rows (and a decided-but-unposted
    /// `score` row), fetched from the row's match id.
    @State private var selected: FinalMatch?

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
            // First load rides .task; the non-force load() no-ops once loaded, so
            // if .task re-fires on a tab return it costs nothing — the actual
            // tab-return refetch is `.refetchWhenSelected` below.
            .task { await store.load() }
            // Returning to the Home tab must re-fetch (clearing a stale "Score
            // needed" banner, refreshing recent results). force: true refreshes
            // in place once content is loaded.
            .refetchWhenSelected(isSelected) { Task { await store.load(force: true) } }
            // Returning to the foreground may surface cross-device changes (a
            // match the other player just accepted) — refetch in place.
            .refetchOnForeground { Task { await store.load(force: true) } }
            // …and while the dashboard is actually in front, don't wait to be
            // returned to: hold the hint stream open and refetch the moment the
            // server says this user's dashboard moved (the opponent accepted, a
            // game score landed, the draw advanced). Same in-place `load(force:)`
            // as every other trigger — the content on screen stays put and is
            // swapped when the new payload arrives, so a push never blanks a
            // dashboard the user is reading. The stream is torn down when the
            // app backgrounds or another tab is selected.
            .refetchOnRealtimeHint(whileSelected: isSelected) {
                Task { await store.load(force: true) }
            }
            // The signed-in identity just changed under us — an in-app sign-in /
            // account merge folded a new user into the session. The dashboard
            // payload (rating, opponent) is now for the wrong account; refetch so
            // Home isn't stale until a relaunch. `.onChange` skips the initial
            // value, so this fires only on a later merge, not first load.
            .onChange(of: session.username) { _, _ in
                Task { await store.load(force: true) }
            }

            if resumeLoading { FMBlockingSpinner() }
        }
        // The match just changed (result posted / games entered) — refetch so the
        // attention panel clears the row and the recent results update.
        .resumeScoringCover($resuming) { Task { await store.load(force: true) } }
        // Detail covers review/dispute (and decided-but-unposted) rows; refetch
        // on dismissal so a resolved row drops off the panel.
        .fullScreenCover(item: $selected) { match in
            MatchDetailView(initial: match, onBack: {
                selected = nil
                Task { await store.load(force: true) }
            })
        }
    }

    /// Run an attention row's action: fetch the full match, then deep-link into
    /// scoring (a `score` row whose board is still live) or open match detail
    /// (review/dispute, or a board that has since been decided). Mirrors the web
    /// view-model's `routeOf` and the matches-list `openResume` fallback.
    private func act(on row: AttentionRowView) {
        switch row.target {
        case .scoring: open(matchId: row.matchId, preferScoring: true)
        case .detail: open(matchId: row.matchId, preferScoring: false)
        }
    }

    /// Run a tournament card's action. Deliberately the *same* path as the
    /// attention row above — one dashboard must not have two ways to open the
    /// same match. The projection has already chosen the target; the game number
    /// it carries is informational, since the resume flow resumes at whatever
    /// game the fetched board says is next (exactly as the attention row does).
    private func act(on target: TournamentMatchTarget) {
        switch target {
        case let .scoring(matchId, _): open(matchId: matchId, preferScoring: true)
        case let .detail(matchId): open(matchId: matchId, preferScoring: false)
        }
    }

    /// Fetch the full match behind a row/card and present it: live scoring when
    /// the caller asked for it *and* the board still allows it, match detail
    /// otherwise. The fallback matters — a board decided since the dashboard
    /// loaded has no `resumeContext`, and detail is where the result gets posted.
    private func open(matchId: UUID, preferScoring: Bool) {
        guard !resumeLoading else { return }
        resumeLoading = true
        Task {
            let detail = try? await service.matchDetails(matchId)
            resumeLoading = false
            guard let detail else { return }
            if preferScoring, let ctx = detail.resumeContext { resuming = ctx }
            else { selected = detail }
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
    /// taps the attention panel's "View all". Nil if the session isn't resolved.
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
            // ABOVE everything else, and only while it exists: the tournament
            // the user is currently playing in. During a tournament the match in
            // front of you outranks every other to-do on this screen, so a
            // player standing at a table doesn't scroll for it. `[]` the rest of
            // the time — which is almost always — and then the dashboard looks
            // exactly as it did before. Mirrors the web dashboard, which renders
            // its `TournamentPanel` above the attention panel.
            ForEach(projectTournamentPanels(data.tournaments, youName: currentUsername)) { panel in
                DashboardTournamentPanel(view: panel, onAct: { act(on: $0) })
            }

            // Server-ranked triage of every match needing the user's move —
            // disputes, results to review, matches to score (issue #445).
            // Mirrors the web dashboard's "Needs your attention" panel: top 3
            // rows + a footer rolling up the overflow / waiting counts, with a
            // "View all" link into the Matches tab.
            DashboardAttentionPanel(
                view: projectAttentionPanel(
                    items: data.attention,
                    waitingCount: data.waitingCount,
                    attentionTotalCount: data.attentionTotalCount
                ),
                onAct: { act(on: $0) },
                onViewAll: { onViewAll?(currentUsername) }
            )

            HStack(alignment: .firstTextBaseline, spacing: FMSpace.s3) {
                Text("Your game")
                    .font(FMFont.ui(FMFont.md, weight: .semibold))
                    .foregroundStyle(FMColor.fg1)
                Text(yourGameSubtitle(data.rating))
                    .font(FMFont.ui(FMFont.sm))
                    .foregroundStyle(FMColor.fgMuted)
                Spacer()
            }

            switch data.rating.state {
            case .rated:
                DashboardRatingCard(rating: data.rating)
            case .unrated:
                emptyRatingCard("Unrated — finish a rated match to start your rating")
            case .awaitingImport:
                emptyRatingCard("Ratings haven't been imported for this league yet")
            case .notRatedLeague, .unknown:
                // `.unknown` (a state added after this build shipped) falls back
                // to the same copy as `.notRatedLeague`, mirroring the web
                // client's default-to-`NOT_RATED_LEAGUE` behaviour.
                emptyRatingCard("Not in a rated league yet.")
            }

            DashboardRecentResultsCard(rows: data.recentResults)
        }
    }

    private func yourGameSubtitle(_ rating: DashboardRating) -> String {
        guard let label = rating.strategyLabel else { return "Last 30 days" }
        return "\(label) · last 30 days"
    }

    /// The non-`.rated` empty state for the "Current rating" card — same
    /// `FMCard`/`DashOverline` shell as the `.rated` card, with per-state copy
    /// (mirrors the web's `EmptyCard` + `EMPTY_RATING_COPY`,
    /// `web-client/src/components/dashboard/your-game-row.tsx`).
    private func emptyRatingCard(_ body: String) -> some View {
        FMCard {
            VStack(alignment: .leading, spacing: FMSpace.s3) {
                DashOverline(text: "Current rating")
                Text(body)
                    .font(FMFont.ui(FMFont.sm))
                    .foregroundStyle(FMColor.fg3)
            }
        }
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

#Preview {
    DashboardView()
        .environmentObject(SessionStore())
        .preferredColorScheme(.dark)
}
