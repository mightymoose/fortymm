import Foundation

/// The tournament panel's view model, and the pure projection that builds it
/// from the decoded `DashboardResponse.tournaments`. The iOS counterpart of
/// `web-client/src/components/dashboard/tournament-panel-view.ts` — a
/// translation of a settled design, not a redesign.
///
/// Every label the panel prints is decided here, once, rather than in the view:
/// the view branches only on fields this projection already resolved, so a copy
/// change is a change to one pure function over plain values. Nothing in this
/// file touches SwiftUI, the network, or navigation.

// MARK: - View model

/// Shown wherever the opposing side of a fixture is still undecided — the
/// server's `opponentUsername: nil`, which means TBD, never "solo".
private let tbdOpponent = "TBD"

/// Where a tournament card's button takes the user. Mirrors the web view
/// model's `MatchRoute`, and carries the match id in the case itself (unlike
/// `AttentionTarget`, whose row always has one) because a fixture with no match
/// behind it must not be able to produce a target at all.
enum TournamentMatchTarget: Equatable {
    /// Deep-link straight into scoring the named game.
    case scoring(matchId: UUID, gameNumber: Int)
    /// Match detail — which holds accept / counter / post-result.
    case detail(matchId: UUID)
}

/// The card's single primary action, or `nil` on the card when there's nothing
/// for this player to do.
struct TournamentMatchAction: Equatable {
    /// e.g. `Enter Game 4 result`, `Post the result`, `Review result`.
    let label: String
    let target: TournamentMatchTarget
}

/// One per-game chip of the focus match, always the viewer's points first.
struct TournamentGameChipView: Equatable, Identifiable {
    /// The game number, which is also its identity within one card.
    let number: Int
    /// `Game 3`.
    let label: String
    /// `11–9`, viewer's points first.
    let score: String
    /// Full sentence for VoiceOver, since the chip itself is two numerals.
    let description: String

    var id: Int { number }
}

/// The panel's focus-match card.
struct TournamentMatchCardView: Equatable {
    let state: TournamentMatchState
    /// The status line: `Live · Table 4 · Game 4`, `Match complete · Group
    /// match 2 · Table 2`, or the round for a match not yet started.
    let statusText: String
    /// `Best of 5`, or `Single game` for a one-game match.
    let bestOfText: String
    /// The viewer's own handle — the panel is a first-person surface, so their
    /// row is named, not labelled "You".
    let youName: String
    let opponentName: String
    let yourGames: Int
    let opponentGames: Int
    /// Which row (if either) carries the winner chip. Both `false` while a match
    /// is live or after it was voided — neither has a winner.
    let youWon: Bool
    let opponentWon: Bool
    /// `mightymoose shown first · vs slim-manatee` — the legend that makes the
    /// game chips readable. `nil` when there are no chips to explain.
    let gamesLegend: String?
    let games: [TournamentGameChipView]
    /// `nil` when there is nothing to do yet: an uncalled match can't be scored,
    /// a finished one has nothing left to enter, and a result we posted is the
    /// opponent's move.
    let action: TournamentMatchAction?
    /// Where "Match details" goes. `nil` for a fixture with no match behind it
    /// yet — there is no screen to open.
    let detailsTarget: TournamentMatchTarget?
    /// `6:00 PM CDT · Table 3` for a match not yet started; `nil` otherwise.
    let scheduleText: String?
}

/// One line of the tab's "Your matches" path.
struct TournamentPathRowView: Equatable, Identifiable {
    /// The row's ordinal within its event, which is stable inside one payload —
    /// the fixture's own match id is `nil` until it materialises, so it can't be
    /// the identity (and a repeated opponent must still render twice).
    let id: String
    /// `M2`.
    let label: String
    let opponentName: String
    let state: TournamentFixtureState
    /// Right-hand text: a result, `In progress`, or a time and table.
    let detail: String
    /// Drives the row's tone. `nil` for anything not yet decided.
    let youWon: Bool?
}

/// The tab's stats strip: record, standing, stage.
struct TournamentStatsView: Equatable {
    let wins: Int
    let losses: Int
    /// `Group position` — what the middle tile counts.
    let positionLabel: String
    /// `1st`, or `nil` when the event has no standings to stand in yet.
    let positionValue: String?
    /// `of 4`, or `nil` alongside a nil position.
    let positionSuffix: String?
    /// `Group play` / `Group complete`.
    let stageValue: String
}

/// One event of the tournament — one tab of the panel.
struct TournamentTabView: Equatable, Identifiable {
    let id: UUID
    let name: String
    /// Puts the pulsing "Live" marker on the tab.
    let live: Bool
    let stats: TournamentStatsView
    let match: TournamentMatchCardView?
    /// `Your matches` — the path list's heading, in the draw type's vocabulary.
    let pathHeading: String
    let path: [TournamentPathRowView]
    /// Names the pool the path belongs to, e.g. `Pool A · 4 players`. `nil` for
    /// an un-pooled draw or before the viewer has been drawn into one.
    let pathSubheading: String?
}

/// One whole panel — one live tournament.
struct TournamentPanelView: Equatable, Identifiable {
    let id: UUID
    let name: String
    let subtitle: String
    /// `1 live now`, or `nil` when nothing of the viewer's is being played.
    let liveLabel: String?
    /// `View group & standings` / `View draw` — where the header link goes, in
    /// the draw type's own words.
    let destinationLabel: String
    let tabs: [TournamentTabView]
}

// MARK: - Projection

/// `3` → `3rd`. 11th/12th/13th are the exceptions every naive version gets wrong.
private func ordinal(_ n: Int) -> String {
    let teen = n % 100
    if teen >= 11 && teen <= 13 { return "\(n)th" }
    switch n % 10 {
    case 1: return "\(n)st"
    case 2: return "\(n)nd"
    case 3: return "\(n)rd"
    default: return "\(n)th"
    }
}

/// Join the parts of a status line, dropping the ones the server had no value
/// for — so an unplaced or unscheduled match loses that segment rather than
/// printing an empty one.
private func joinParts(_ parts: String?...) -> String {
    parts.compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ")
}

private func statusText(_ match: DashboardTournamentMatch) -> String {
    switch match.state {
    case .live:
        // `nextGameNumber` is the game about to be played. It is `nil` when the
        // board already DECIDES the match but the result hasn't been posted —
        // and there the card must name no game at all. Falling back to
        // `games.count + 1` would print "Game 3" for a match that is over,
        // reintroducing the phantom game number the server refuses to emit and
        // contradicting the button beside it, which correctly offers nothing to
        // enter.
        return joinParts(
            "Live",
            match.tableLabel,
            match.nextGameNumber.map { "Game \($0)" }
        )
    case .completed:
        return joinParts("Match complete", match.roundLabel, match.tableLabel)
    case .voided:
        // A voided match contributes nothing (ADR-0013) — the card names the
        // fact and shows no outcome. It deliberately does NOT read as a
        // completed match, which would derive a loss from the empty board.
        return joinParts("Match voided", match.roundLabel)
    case .scheduled, .unknown:
        // A state this build doesn't know is treated like an unstarted match:
        // name the round, offer no action. Never invent an outcome for it.
        return match.roundLabel
    }
}

private func action(_ match: DashboardTournamentMatch) -> TournamentMatchAction? {
    // A scheduled (uncalled) match isn't scorable and a finished one has nothing
    // left, so both answer `nil` rather than a button that 409s or lies.
    guard match.state == .live, let matchId = match.matchId else { return nil }
    switch match.owedAction {
    case .score:
        // Mid-board: enter the next game. With no next game the board is decided
        // and unposted — what's left is to post the result, which match detail
        // holds. (Answering `nil` there dead-ended the card at the one moment the
        // player most needs a way forward.)
        guard let next = match.nextGameNumber else {
            return TournamentMatchAction(
                label: "Post the result",
                target: .detail(matchId: matchId)
            )
        }
        return TournamentMatchAction(
            label: "Enter Game \(next) result",
            target: .scoring(matchId: matchId, gameNumber: next)
        )
    case .review:
        // The OPPONENT posted a result; this player owes it a look. Labelling
        // this "Post the result" would name a job that's already done, and done
        // by someone else.
        return TournamentMatchAction(
            label: "Review result",
            target: .detail(matchId: matchId)
        )
    case .waitingOpponent, .waitingOthers, .unknown, .none:
        // The move isn't ours: no button. The card still links to match details,
        // which is where a standing result can be watched.
        return nil
    }
}

private func scheduleText(_ match: DashboardTournamentMatch) -> String? {
    guard match.state == .scheduled else { return nil }
    let placed = joinParts(match.startLabel, match.tableLabel)
    return placed.isEmpty ? "Not scheduled yet" : placed
}

private func projectMatch(
    _ match: DashboardTournamentMatch,
    youName: String
) -> TournamentMatchCardView {
    let opponentName = match.opponentUsername ?? tbdOpponent
    let games = match.games.map { game in
        TournamentGameChipView(
            number: game.number,
            label: "Game \(game.number)",
            score: "\(game.yourPoints)–\(game.opponentPoints)",
            description: "Game \(game.number): \(youName) \(game.yourPoints), "
                + "\(opponentName) \(game.opponentPoints)"
        )
    }
    return TournamentMatchCardView(
        state: match.state,
        statusText: statusText(match),
        // A best-of-1 is a single game, so it drops the "Best of N" race framing
        // that only means something for a multi-game set.
        bestOfText: match.bestOf == 1 ? "Single game" : "Best of \(match.bestOf)",
        youName: youName,
        opponentName: opponentName,
        yourGames: match.yourGames,
        opponentGames: match.opponentGames,
        // `youWon` is nil until the match is decided, so neither row is crowned
        // mid-match — treating that nil as `false` would put the chip on the
        // opponent of every live (and every voided) match.
        youWon: match.youWon == true,
        opponentWon: match.youWon == false,
        gamesLegend: games.isEmpty
            ? nil
            : "\(youName) shown first · vs \(opponentName)",
        games: games,
        action: action(match),
        detailsTarget: match.matchId.map { .detail(matchId: $0) },
        scheduleText: scheduleText(match)
    )
}

/// Whether the draw seats players in a *pool* — a group with a standings table
/// and a fixture per opponent — as opposed to a bracket, where a player has a
/// path through rounds and no standing at all. This is the only distinction the
/// panel's wording turns on, at all three sites below.
///
/// Written as an exhaustive `switch` rather than the `== .roundRobin` this used
/// to be so that adding a case to `TournamentDrawType` stops the build *here*,
/// where that draw type's vocabulary has to be chosen deliberately, instead of
/// silently inheriting the bracket wording. `.unknown` is grouped with the
/// brackets on purpose: it's the lenient decoder's landing pad for a value this
/// build doesn't know, and "path"/"Position" is the reading that doesn't claim
/// a pool and a standings table that may not exist.
private func isPooledDraw(_ drawType: TournamentDrawType) -> Bool {
    switch drawType {
    case .roundRobin:
        return true
    case .singleElim, .unknown:
        return false
    }
}

private func projectStats(_ event: DashboardTournamentEvent) -> TournamentStatsView {
    TournamentStatsView(
        wins: event.wins,
        losses: event.losses,
        positionLabel: isPooledDraw(event.drawType) ? "Group position" : "Position",
        // No standings is not a zeroth place: both tiles go quiet together.
        positionValue: event.position.map(ordinal),
        positionSuffix: event.position.map { _ in "of \(event.fieldSize)" },
        stageValue: event.stageLabel
    )
}

private func projectTab(
    _ event: DashboardTournamentEvent,
    youName: String
) -> TournamentTabView {
    TournamentTabView(
        id: event.id,
        name: event.name,
        live: event.isLive,
        stats: projectStats(event),
        match: event.match.map { projectMatch($0, youName: youName) },
        pathHeading: isPooledDraw(event.drawType) ? "Your matches" : "Your path",
        path: event.fixtures.enumerated().map { index, fixture in
            TournamentPathRowView(
                id: "\(event.id.uuidString)-\(index)",
                label: fixture.label,
                opponentName: fixture.opponentUsername ?? tbdOpponent,
                state: fixture.state,
                detail: fixture.detail,
                youWon: fixture.youWon
            )
        },
        pathSubheading: event.poolLabel.map { pool in
            event.fieldSize > 0 ? "\(pool) · \(event.fieldSize) players" : pool
        }
    )
}

/// A round-robin's destination is its standings table; anything else is a
/// bracket. Keyed off every tab because the header link is per-tournament — and
/// "View draw" reads correctly for a mixed tournament either way.
private func destinationLabel(_ events: [DashboardTournamentEvent]) -> String {
    events.allSatisfy { isPooledDraw($0.drawType) }
        ? "View group & standings"
        : "View draw"
}

/// Project one live tournament from the dashboard payload into the panel's view
/// model — labels, ordinals, targets and the tab strip.
///
/// `youName` is the viewer's own handle, which the payload deliberately doesn't
/// repeat: every score on it is already stated from the caller's side, so the
/// only thing missing is what to *call* them, and the app already knows that
/// from the shared `SessionStore`.
///
/// Mirrors the web's `projectTournamentPanelView`.
func projectTournamentPanel(
    _ tournament: DashboardTournament,
    youName: String
) -> TournamentPanelView {
    TournamentPanelView(
        id: tournament.id,
        name: tournament.name,
        subtitle: tournament.subtitle,
        liveLabel: tournament.liveCount > 0 ? "\(tournament.liveCount) live now" : nil,
        destinationLabel: destinationLabel(tournament.events),
        tabs: tournament.events.map { projectTab($0, youName: youName) }
    )
}

/// Every live tournament the viewer is playing in, as panels — `[]` when they're
/// in none, which is almost always, and the dashboard then renders nothing.
///
/// A `nil` array is read the same as an empty one: the field carries a
/// server-side default and so is optional on the wire, and an API that omits it
/// means "no tournaments", not "broken dashboard".
///
/// `youName` is optional for the same reason the web's is: every number on the
/// payload is stated from the caller's side, so without a name for them the card
/// would label their own row with nothing. No handle, no panel.
///
/// An event-less tournament is dropped rather than rendered as an empty panel:
/// the panel is entirely made of its tabs, so one with no tabs is a heading over
/// nothing. (The server can't emit one today — a panel exists because the viewer
/// holds an entry in one of its events — but the panel mustn't depend on that to
/// avoid rendering a husk.)
///
/// Mirrors the web's `projectTournamentPanelViews`.
func projectTournamentPanels(
    _ tournaments: [DashboardTournament]?,
    youName: String?
) -> [TournamentPanelView] {
    guard let youName, !youName.isEmpty, let tournaments else { return [] }
    return tournaments
        .filter { !$0.events.isEmpty }
        .map { projectTournamentPanel($0, youName: youName) }
}
