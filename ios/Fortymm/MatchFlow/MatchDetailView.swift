import SwiftUI

/// Screen 3 — posted match detail / Final summary. The score scales in with
/// a ball-bounce on appear, suppressed under Reduce Motion.
struct MatchDetailView: View {
    /// The match as first handed in — from a freshly posted result (already
    /// full) or a list row (sparse: no games/H2H yet). `live` replaces it once
    /// the detail BFF is fetched on appear.
    let initial: FinalMatch
    var service: MatchService = .shared
    var onBack: () -> Void

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var reveal = false
    @State private var live: FinalMatch?

    /// An accept (or post) request is in flight (blocks the footer + dims the UI).
    @State private var actioning = false
    @State private var actionError: String?
    /// Non-nil while the resume-scoring flow is presented over this screen.
    @State private var resuming: ResumeScoring?

    /// What the screen renders: the freshest copy we have.
    private var match: FinalMatch { live ?? initial }
    private var need: Int { MatchRules.gamesToWin(bestOf: match.bestOf) }

    var body: some View {
        ZStack(alignment: .bottom) {
            FMColor.ink950.ignoresSafeArea()
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    breadcrumb
                    hero
                    // `diff` is only populated for the `corrected` phase, so
                    // non-emptiness alone gates the section.
                    if let diff = match.negotiation?.diff, !diff.isEmpty {
                        whatChangedSection(diff)
                    }
                    if !match.games.isEmpty { gamesSection }
                    if match.rated, let delta = match.ratingDelta { ratingSection(delta) }
                    infoSection
                    if let h2h = match.h2h, !match.solo { headToHeadSection(h2h) }
                }
                .padding(.bottom, 120)
            }
            // Pull-to-refresh: the one in-foreground way to pick up a cross-device
            // change (the opponent accepted or corrected) while staring at this
            // screen, since there's no live poll. Mirrors the dashboard/matches-list
            // pulls.
            .refreshable { await refresh(force: true) }
            footer
            if actioning { FMBlockingSpinner() }
        }
        .onAppear {
            if reduceMotion { reveal = true }
            else { withAnimation(.spring(response: 0.42, dampingFraction: 0.5).delay(0.06)) { reveal = true } }
        }
        .task { await refresh() }
        // Foregrounding may reveal a cross-device change (the opponent accepted
        // or corrected the posted result) — refetch so the status isn't stale.
        .refetchOnForeground { Task { await refresh(force: true) } }
        .alert(
            "Something went wrong",
            isPresented: Binding(
                get: { actionError != nil },
                set: { if !$0 { actionError = nil } }
            )
        ) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(actionError ?? "")
        }
        // The match changed underneath us (games posted, or simply more games
        // entered) — refetch so the detail reflects the new state.
        .resumeScoringCover($resuming) { Task { await refresh(force: true) } }
    }

    /// The viewer-relative negotiation phase (`.unknown` for seed/preview data).
    private var negotiationState: ViewerStateDTO {
        match.negotiation?.viewerState ?? .unknown
    }

    /// Accept the standing proposal, making the result official. The standing
    /// result's id is the concurrency token: a 409 means the proposal moved on
    /// (the opponent posted a correction the viewer hasn't seen) — mirror the
    /// web's behavior by refetching and prompting a re-review rather than
    /// silently retargeting the new result (#726).
    private func accept() async {
        guard !actioning,
              let id = UUID(uuidString: match.id),
              let resultId = match.negotiation?.standingResultId else { return }
        actioning = true
        defer { actioning = false }
        do {
            let updated = try await service.acceptResult(matchId: id, resultId: resultId)
            withAnimation { live = updated }
        } catch APIError.http(409, _) {
            actionError = "This result changed — review the latest score before accepting."
            await refresh(force: true)
        } catch {
            actionError = error.fmMessage
        }
    }

    /// Post the result of a match that's been scored to a decision but never
    /// posted (the `can_finalize` recovery path) — sends the already-saved games
    /// and refreshes. For a solo match this finalizes immediately; a two-player
    /// match moves to awaiting the opponent's confirmation.
    private func finalize() async {
        guard !actioning, let id = UUID(uuidString: match.id) else { return }
        actioning = true
        defer { actioning = false }
        do {
            let updated = try await service.postResult(
                matchId: id, games: match.games, yourSideNumber: match.yourSideNumber
            )
            withAnimation { live = updated }
        } catch {
            actionError = error.fmMessage
        }
    }

    /// Pull the full detail (games, rating, head-to-head, current status) for
    /// the match. On first load (`force: false`) it's skipped when we already
    /// hold the full payload (a freshly posted result) or for non-server ids
    /// (e.g. SwiftUI previews) — a list row arrives without games, so that path
    /// fetches. `force: true` always refetches: used after an action (resume,
    /// sign-off) or on foreground, where the held copy is known to be stale.
    private func refresh(force: Bool = false) async {
        guard force || initial.games.isEmpty, let id = UUID(uuidString: match.id) else { return }
        if let updated = try? await service.matchDetails(id) {
            withAnimation { live = updated }
        }
    }

    // MARK: Breadcrumb

    private var breadcrumb: some View {
        HStack(spacing: 6) {
            Button(action: onBack) {
                Image(systemName: "arrow.left")
                    .font(.system(size: 18, weight: .medium))
                    .foregroundStyle(FMColor.fg3)
                    .frame(width: 40, height: 40)
            }
            .buttonStyle(.plain)
            (Text("MATCHES ").foregroundStyle(FMColor.fgMuted)
                + Text("›  ").foregroundStyle(FMColor.ink500)
                + Text("MATCH \(shortID)").foregroundStyle(FMColor.fg3))
                .font(FMFont.ui(11, weight: .semibold))
                .tracking(1.2)
        }
        .padding(.horizontal, 16)
        .padding(.bottom, 6)
    }

    // MARK: Hero

    private var hero: some View {
        VStack(spacing: 20) {
            HStack {
                HStack(spacing: 7) {
                    Circle().fill(statusColor).frame(width: 7, height: 7)
                        .shadow(color: statusColor.opacity(0.55), radius: 5)
                    Text(match.statusLabel.uppercased()).font(FMFont.ui(11, weight: .semibold)).tracking(1.0)
                }
                .foregroundStyle(statusColor)
                .padding(.horizontal, 11)
                .padding(.vertical, 5)
                .background(FMColor.bgAccentSoft)
                .overlay(Capsule().stroke(statusColor.opacity(0.4), lineWidth: 1))
                .clipShape(Capsule())
                Spacer()
                Text("SINGLES · BO\(match.bestOf) · FIRST TO \(need)")
                    .font(FMFont.ui(10, weight: .semibold))
                    .tracking(1.0)
                    .foregroundStyle(FMColor.fgMuted)
            }

            HStack(spacing: 8) {
                playerColumn(match.you, name: match.you.handle)
                VStack(spacing: 6) {
                    HStack(spacing: 10) {
                        Text("\(match.setsWon.a)").foregroundStyle(FMColor.fg2)
                        Text("-").font(FMFont.mono(30)).foregroundStyle(FMColor.fgMuted)
                        Text("\(match.setsWon.b)").foregroundStyle(FMColor.fg2)
                    }
                    .font(FMFont.mono(60, weight: .bold))
                    .scaleEffect(reveal ? 1 : 0.7)
                    .opacity(reveal ? 1 : 0)
                    Text(match.statusLabel.uppercased())
                        .font(FMFont.ui(11, weight: .medium))
                        .tracking(1.4)
                        .foregroundStyle(FMColor.fgMuted)
                }
                .frame(maxWidth: .infinity)
                playerColumn(match.opponent, name: match.opponent.handle)
            }

            if match.awaitingConfirmation {
                VStack(spacing: 5) {
                    Text(negotiationCopy)
                        .font(FMFont.ui(12, weight: .medium))
                        .foregroundStyle(FMColor.fg3)
                    if match.canConfirm {
                        // The stakes line, mirroring the web callout.
                        Text(match.rated
                             ? "Accepting finalizes this rated match and updates both ratings."
                             : "Accepting finalizes this match. It doesn't affect ratings.")
                            .font(FMFont.ui(11, weight: .medium))
                            .foregroundStyle(FMColor.fgMuted)
                    }
                }
                .multilineTextAlignment(.center)
                .frame(maxWidth: .infinity, alignment: .center)
            }
        }
        .padding(.horizontal, 18)
        .padding(.top, 18)
        .padding(.bottom, 22)
        .background(FMColor.ink900)
        .fmRoundedBorder(radius: 18, color: FMColor.borderSubtle)
        .padding(.horizontal, 16)
        .padding(.top, 8)
    }

    /// The one-line negotiation status under the hero score, keyed off the
    /// viewer phase — mirrors the web's confirmation callout copy.
    private var negotiationCopy: String {
        switch negotiationState {
        case .review:
            return "\(match.opponent.handle) posted this result. Accept it to make it official, or suggest a correction."
        case .corrected:
            return "\(match.opponent.handle) corrected the score. Review what changed, then accept the correction or counter."
        default:
            return "Result posted — awaiting \(match.opponent.handle)'s acceptance."
        }
    }

    /// Orange once the result is official; amber while it's still provisional.
    private var statusColor: Color { match.decided ? FMColor.ball500 : FMColor.warn }

    /// First segment of the match UUID — enough to identify it in the crumb.
    private var shortID: String { String(match.id.prefix(8)).uppercased() }

    private func playerColumn(_ player: MatchPlayer, name: String) -> some View {
        VStack(spacing: 8) {
            MatchAvatar(player: player, size: 52)
            Text(name)
                .font(FMFont.ui(13, weight: .semibold))
                .foregroundStyle(FMColor.fg1)
                .multilineTextAlignment(.center)
        }
        .frame(width: 96)
    }

    // MARK: What changed (corrected-phase diff)

    /// The server-computed per-game diff between the viewer's prior proposal
    /// and the standing correction: old score struck through → new score, with
    /// newly-added games flagged. Scores are canonical side-1–side-2, matching
    /// the web's ScoreDiff.
    private func whatChangedSection(_ diff: [ScoreDiffEntry]) -> some View {
        Section_("What changed") {
            VStack(spacing: 0) {
                ForEach(diff.indices, id: \.self) { i in
                    let entry = diff[i]
                    HStack(spacing: 10) {
                        Text("GAME \(entry.gameNumber)")
                            .font(FMFont.ui(10, weight: .semibold))
                            .tracking(1.2)
                            .foregroundStyle(FMColor.fgMuted)
                            .frame(maxWidth: .infinity, alignment: .leading)
                        if let old = entry.old {
                            Text(old)
                                .font(FMFont.mono(15, weight: .semibold))
                                .strikethrough()
                                .foregroundStyle(FMColor.loss)
                            Image(systemName: "arrow.right")
                                .font(.system(size: 11, weight: .semibold))
                                .foregroundStyle(FMColor.fgMuted)
                        } else {
                            Text("NEW GAME")
                                .font(FMFont.ui(9, weight: .semibold))
                                .tracking(1.0)
                                .foregroundStyle(FMColor.fgMuted)
                        }
                        Text(entry.new)
                            .font(FMFont.mono(15, weight: .bold))
                            .foregroundStyle(FMColor.serve500)
                    }
                    .padding(.horizontal, 16)
                    .padding(.vertical, 12)
                    if i < diff.count - 1 { Divider().overlay(FMColor.ink700) }
                }
            }
            .background(FMColor.ink900)
            .fmRoundedBorder(radius: FMRadius.lg, color: FMColor.borderSubtle)
        }
    }

    // MARK: Games

    private var gamesSection: some View {
        Section_("Games") {
            VStack(spacing: 0) {
                ForEach(Array(match.games.enumerated()), id: \.offset) { i, g in
                    let aw = (g.a ?? 0) > (g.b ?? 0)
                    HStack {
                        Text("GAME \(i + 1)")
                            .font(FMFont.ui(10, weight: .semibold))
                            .tracking(1.2)
                            .foregroundStyle(FMColor.fgMuted)
                            .frame(maxWidth: .infinity, alignment: .leading)
                        HStack(spacing: 14) {
                            Text("\(g.a ?? 0)").foregroundStyle(aw ? FMColor.serve500 : FMColor.fg2)
                                .frame(width: 36, alignment: .trailing)
                            Text("-").font(FMFont.mono(14)).foregroundStyle(FMColor.ink500)
                            Text("\(g.b ?? 0)").foregroundStyle(!aw ? FMColor.serve500 : FMColor.fg2)
                                .frame(width: 36, alignment: .leading)
                        }
                        .font(FMFont.mono(22, weight: .bold))
                    }
                    .padding(.horizontal, 16)
                    .padding(.vertical, 13)
                    if i < match.games.count - 1 { Divider().overlay(FMColor.ink700) }
                }
            }
            .background(FMColor.ink900)
            .fmRoundedBorder(radius: FMRadius.lg, color: FMColor.borderSubtle)
        }
    }

    // MARK: Rating

    private func ratingSection(_ delta: Int) -> some View {
        Section_("Your rating") {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Text("\(match.you.rating + delta)")
                            .font(FMFont.mono(28, weight: .bold))
                            .foregroundStyle(FMColor.fg1)
                        Text("\(delta >= 0 ? "+" : "")\(delta)")
                            .font(FMFont.mono(15, weight: .bold))
                            .foregroundStyle(delta >= 0 ? FMColor.serve500 : FMColor.loss)
                    }
                    Text("was \(match.you.rating)")
                        .font(FMFont.ui(11, weight: .medium))
                        .foregroundStyle(FMColor.fgMuted)
                }
                Spacer()
                Sparkline(up: delta >= 0, color: delta >= 0 ? FMColor.serve500 : FMColor.loss)
                    .frame(width: 112, height: 30)
            }
            .padding(.horizontal, 18)
            .padding(.vertical, 16)
            .background(FMColor.ink900)
            .fmRoundedBorder(radius: FMRadius.lg, color: FMColor.borderSubtle)
        }
    }

    // MARK: Info

    private var infoSection: some View {
        Section_("Match info") {
            VStack(spacing: 0) {
                InfoRow(key: "Format", value: "Best of \(match.bestOf), first to \(need)")
                InfoRow(key: "Scoring", value: "To 11, win by 2")
                InfoRow(key: "Status", value: match.statusLabel, valueColor: statusColor)
                InfoRow(key: "Rated", value: match.rated ? "Yes" : "No",
                        valueColor: match.rated ? FMColor.serve500 : FMColor.fg3, last: true)
            }
            .padding(.horizontal, 16)
            .background(FMColor.ink900)
            .fmRoundedBorder(radius: FMRadius.lg, color: FMColor.borderSubtle)
        }
    }

    // MARK: Head to head

    private func headToHeadSection(_ h2h: MatchH2H) -> some View {
        let w = h2h.youWins
        let l = h2h.themWins
        let total = h2h.total
        let meetings = h2h.meetings.prefix(4)

        return VStack(alignment: .leading, spacing: 11) {
            HStack(alignment: .firstTextBaseline) {
                Eyebrow("Head to head")
                Spacer()
                Text("\(total) MEETINGS")
                    .font(FMFont.ui(10, weight: .medium)).tracking(1.0)
                    .foregroundStyle(FMColor.fgMuted)
            }
            VStack(spacing: 0) {
                HStack(spacing: 14) {
                    Text("\(w)").font(FMFont.mono(26, weight: .bold)).foregroundStyle(FMColor.serve500)
                    Text("you").font(FMFont.ui(11, weight: .medium)).foregroundStyle(FMColor.fgMuted)
                    Text("-").font(FMFont.mono(18)).foregroundStyle(FMColor.ink500)
                    Text("them").font(FMFont.ui(11, weight: .medium)).foregroundStyle(FMColor.fgMuted)
                    Text("\(l)").font(FMFont.mono(26, weight: .bold)).foregroundStyle(FMColor.fg2)
                }
                .padding(.bottom, 12)
                GeometryReader { geo in
                    ZStack(alignment: .leading) {
                        Capsule().fill(FMColor.ink700)
                        Capsule().fill(FMColor.serve500)
                            .frame(width: geo.size.width * (total == 0 ? 0.5 : Double(w) / Double(total)))
                    }
                }
                .frame(height: 7)
                .padding(.bottom, 14)
                ForEach(Array(meetings.enumerated()), id: \.offset) { i, m in
                    HStack {
                        Text(m.when).font(FMFont.ui(12, weight: .medium)).foregroundStyle(FMColor.fg3)
                        Spacer()
                        Text(m.res).font(FMFont.mono(13, weight: .semibold)).foregroundStyle(FMColor.fg2)
                        Text(m.win ? "W" : "L")
                            .font(FMFont.ui(10, weight: .bold))
                            .foregroundStyle(m.win ? FMColor.serve500 : FMColor.loss)
                            .frame(width: 16)
                    }
                    .padding(.vertical, 9)
                    .overlay(alignment: .top) {
                        if i != 0 { Rectangle().fill(FMColor.ink700).frame(height: 1) }
                    }
                }
            }
            .padding(16)
            .background(FMColor.ink900)
            .fmRoundedBorder(radius: FMRadius.lg, color: FMColor.borderSubtle)
        }
        .padding(.horizontal, 16)
        .padding(.top, 20)
    }

    // MARK: Footer

    @ViewBuilder
    private var footer: some View {
        Group {
            if match.canConfirm {
                acceptFooter
            } else if negotiationState == .awaiting, let ctx = match.correctionContext {
                awaitingFooter(ctx)
            } else if match.canFinalize {
                finalizeFooter
            } else if let ctx = match.resumeContext {
                resumeFooter(ctx)
            } else {
                defaultFooter
            }
        }
        .padding(.horizontal, 16)
        .padding(.top, 14)
        .padding(.bottom, 30)
        // Solid backing so scrolled content never shows through the footer bar;
        // the short fade above lets content dissolve as it scrolls up toward it.
        .background {
            FMColor.ink950
                .ignoresSafeArea()
                .overlay(alignment: .top) {
                    LinearGradient(colors: [.clear, FMColor.ink950],
                                   startPoint: .top, endPoint: .bottom)
                        .frame(height: 24)
                        .offset(y: -24)
                }
        }
    }

    /// The footer's full-width ball-gradient pill — shared by every primary
    /// footer action (back, post, resume, accept) so the shape/shadow live once.
    private func footerButton(
        _ title: String, showArrow: Bool = true, disabled: Bool = false,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            HStack(spacing: 8) {
                Text(title).font(FMFont.ui(16, weight: .bold))
                if showArrow { Image(systemName: "arrow.right").font(.system(size: 15, weight: .bold)) }
            }
            .foregroundStyle(FMColor.fgInverse)
            .frame(maxWidth: .infinity)
            .frame(height: 50)
            .background(BallGradient())
            .clipShape(RoundedRectangle(cornerRadius: 13, style: .continuous))
            .shadow(color: FMColor.ball500.opacity(0.32), radius: 11, y: 8)
        }
        .buttonStyle(.plain)
        .disabled(disabled)
    }

    /// Default footer: back to the matches list.
    private var defaultFooter: some View {
        footerButton("Back to matches", showArrow: false, action: onBack)
    }

    /// Finalize footer: a decided board with no result proposed yet. The
    /// primary action posts the saved games as the first proposal — the
    /// recovery path for a match stranded *past* the decider (issue #445).
    /// Because the scores are a scratchpad until a result is proposed, the
    /// board is also still editable, so we also offer "Edit scores" to correct
    /// a game before posting.
    @ViewBuilder
    private var finalizeFooter: some View {
        VStack(spacing: 10) {
            footerButton("Post result", disabled: actioning) { Task { await finalize() } }
            if let ctx = match.resumeContext {
                secondaryFooterButton("Edit scores") { resuming = ctx }
            }
        }
    }

    /// Resume footer: shown for a live match the viewer can still score. This is
    /// the recovery path for a match stranded mid-scoring (issue #445) — a Live
    /// match you own always offers a way to continue.
    private func resumeFooter(_ ctx: ResumeScoring) -> some View {
        footerButton(match.games.isEmpty ? "Enter scores" : "Resume scoring") { resuming = ctx }
    }

    /// A bordered, secondary footer action (the non-primary verb in a pair).
    private func secondaryFooterButton(
        _ title: String, action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            Text(title)
                .font(FMFont.ui(15, weight: .semibold))
                .foregroundStyle(FMColor.fg2)
                .frame(maxWidth: .infinity)
                .frame(height: 48)
                .fmRoundedBorder(radius: 13, color: FMColor.borderDefault)
        }
        .buttonStyle(.plain)
        .disabled(actioning)
    }

    /// Sign-off footer: the current user owes an accept-or-correct on the
    /// standing proposal. Accept makes the result official; the secondary verb
    /// opens the correction board — "Suggest correction" against a first
    /// posting (`review`), "Counter" against a correction of the viewer's own
    /// prior proposal (`corrected`). Mirrors the web's confirmation callout.
    private var acceptFooter: some View {
        VStack(spacing: 10) {
            footerButton("Accept result", showArrow: false, disabled: actioning) {
                Task { await accept() }
            }
            if let ctx = match.correctionContext {
                secondaryFooterButton(
                    negotiationState == .corrected ? "Counter" : "Suggest correction"
                ) { resuming = ctx }
            }
        }
    }

    /// Awaiting footer: the viewer's own side posted the standing proposal —
    /// nothing is owed, but the viewer can still self-edit their posting (a
    /// correction that supersedes it), mirroring the web's "Edit result".
    private func awaitingFooter(_ ctx: ResumeScoring) -> some View {
        VStack(spacing: 10) {
            footerButton("Back to matches", showArrow: false, action: onBack)
            secondaryFooterButton("Edit result") { resuming = ctx }
        }
    }
}

// MARK: - Reusable detail bits

/// Eyebrow-titled detail section (underscore avoids clashing with SwiftUI.Section).
private struct Section_<Content: View>: View {
    let title: String
    @ViewBuilder var content: () -> Content
    init(_ title: String, @ViewBuilder content: @escaping () -> Content) {
        self.title = title; self.content = content
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 11) {
            Eyebrow(title)
            content()
        }
        .padding(.horizontal, 16)
        .padding(.top, 20)
    }
}

private struct InfoRow: View {
    let key: String
    let value: String
    var valueColor: Color = FMColor.fg1
    var last: Bool = false
    var body: some View {
        HStack {
            Text(key).font(FMFont.ui(13, weight: .medium)).foregroundStyle(FMColor.fg3)
            Spacer()
            Text(value).font(FMFont.mono(13, weight: .semibold)).tracking(0.4).foregroundStyle(valueColor)
        }
        .padding(.vertical, 13)
        .overlay(alignment: .bottom) {
            if !last { Rectangle().fill(FMColor.ink700).frame(height: 1) }
        }
    }
}

/// Tiny up/down rating trend line (decorative — fixed shape from the prototype).
private struct Sparkline: View {
    let up: Bool
    let color: Color
    private var points: [CGPoint] {
        let raw: [(CGFloat, CGFloat)] = up
            ? [(0,26),(18,22),(36,24),(54,15),(72,17),(90,8),(108,4)]
            : [(0,6),(18,9),(36,7),(54,14),(72,12),(90,20),(108,26)]
        return raw.map { CGPoint(x: $0.0, y: $0.1) }
    }
    var body: some View {
        ZStack {
            Path { p in
                p.addLines(points)
            }
            .stroke(color, style: StrokeStyle(lineWidth: 2, lineCap: .round, lineJoin: .round))
            if let last = points.last {
                Circle().fill(color).frame(width: 6, height: 6).position(last)
            }
        }
        .frame(width: 112, height: 30)
    }
}

