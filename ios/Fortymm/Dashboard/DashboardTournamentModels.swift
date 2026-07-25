import Foundation

/// Decodable mirrors of the API's `DashboardTournament*` schemas
/// (`api/app/schemas/dashboard.py`) — the panel that tops the dashboard while
/// the caller is playing in a live tournament.
///
/// Two properties of this payload are load-bearing, and every type below is
/// shaped to preserve them:
///
/// 1. **Everything is stated from the caller's side.** `yourGames` /
///    `opponentGames` / `yourPoints` are the *caller's*, already flipped
///    server-side — a fixture seats entry A on side 1 and entry B on side 2, so
///    a side-shaped score reads backwards for whichever player is entry B. No
///    client needs to know which side it sits on.
/// 2. **A `nil` is a fact, not a missing value.** `position: nil` means the
///    event has no standings to stand in; `matchId: nil` means the fixture
///    hasn't materialised into a match; `opponentUsername: nil` means the other
///    side is still TBD; `youWon: nil` means the match has no outcome yet (or
///    was voided, and never will have one). None of these may be flattened to
///    `0` / `""` / `false` — see `DashboardTournamentPanelProjection.swift`,
///    which carries each of them through as its own case.
///
/// Decoded by `APIClient`'s shared `JSONDecoder` with `.convertFromSnakeCase`,
/// so `live_count` arrives as `liveCount` and `your_points` as `yourPoints`. No
/// key here has a digit segment, so none needs explicit `CodingKeys`; and no
/// field is a `[String: T]` map, so the iOS-17 dictionary-key mangling that
/// `StatusCounts` (`MatchFlow/MatchAPI.swift`) defends against cannot arise.

// MARK: - Closed string domains

/// The state of the one match the panel puts in front of the player. Mirrors
/// the API's `TournamentMatchState`.
///
/// `voided` is its own case and *not* a flavour of `completed`: a voided match
/// has no winner at all, and folding it in would derive a loss from a 0–0 board.
enum TournamentMatchState: String, LenientRawDecodable {
    /// Being played right now.
    case live
    /// Due next — possibly not even called yet, in which case there is no match
    /// behind it (`matchId == nil`).
    case scheduled
    /// Finished, with an outcome in `youWon`.
    case completed
    /// Struck from the record — no winner, no score.
    case voided
    case unknown
}

/// A row's state in the panel's "Your matches" path. Mirrors the API's
/// `TournamentFixtureState` — deliberately *not* `APIMatchStatus`, because a
/// fixture that hasn't materialised into a match has no match status at all,
/// and that is exactly the `upcoming` case this path exists to show.
enum TournamentFixtureState: String, LenientRawDecodable {
    case completed
    case live
    case upcoming
    case voided
    case unknown
}

/// Mirror of `app.models.tournament.DrawType`. Only `roundRobin` is implemented
/// server-side today; the rest are enum stubs, so the panel keys its vocabulary
/// ("Your matches" vs "Your path") off round-robin and treats everything else —
/// including a draw type added later, which lands as `.unknown` — as a bracket.
enum TournamentDrawType: String, LenientRawDecodable {
    case singleElim = "single-elim"
    case doubleElim = "double-elim"
    case roundRobin = "round-robin"
    case rrThenKo = "rr-then-ko"
    case swiss
    case unknown
}

/// What the caller owes on the panel's focus match, from the same classifier the
/// attention panel is built on (`app.attention.list_attention_kind`) — so the two
/// panels on one dashboard can't label the same match differently.
///
/// This is the *only* honest source for the card's action. `nextGameNumber == nil`
/// is not enough and reading it that way is a bug the web panel shipped once: it
/// is `nil` both when the board is decided-but-unposted (**post** it) and when a
/// result is already posted and awaiting acceptance (**review** it, or, if we
/// posted it, do nothing).
///
/// The field itself is optional on the wire; `nil` means there is nothing to do.
enum TournamentOwedAction: String, LenientRawDecodable {
    /// The opponent posted a result; the caller owes it a look.
    case review
    /// The caller owes a score — the next game, or the result of a decided board.
    case score
    /// The caller posted; the accept is the opponent's move.
    case waitingOpponent = "waiting_opponent"
    /// Someone other than these two owes the next move.
    case waitingOthers = "waiting_others"
    case unknown
}

// MARK: - Payload

/// One completed game of the focus match, scored from the caller's side —
/// `yourPoints` is always theirs, never side 1's.
struct DashboardTournamentGame: Decodable, Equatable {
    let number: Int
    let yourPoints: Int
    let opponentPoints: Int
}

/// The one match the panel's card shows for an event, already resolved
/// server-side to the single most relevant one: the live match if there is one,
/// else the next scheduled fixture, else the last completed match.
struct DashboardTournamentMatch: Decodable, Equatable {
    let state: TournamentMatchState
    /// `nil` for a `scheduled` fixture that hasn't materialised into a match —
    /// there is then nothing to deep-link, which is exactly what an un-called
    /// fixture is. Never `nil` for `live` / `completed`.
    let matchId: UUID?
    /// `nil` means the opposing side is still TBD (an undecided feeding fixture).
    let opponentUsername: String?
    /// Games *won* by the caller (not points).
    let yourGames: Int
    let opponentGames: Int
    let bestOf: Int
    let games: [DashboardTournamentGame]
    /// e.g. `Group match 2` — composed in the vocabulary of the draw type, so
    /// the client never maps a round number to a word.
    let roundLabel: String
    /// The venue table this fixture is placed on, or `nil` when unplaced.
    let tableLabel: String?
    /// The scheduled start, already rendered in the event's venue timezone with
    /// its abbreviation (e.g. `4:30 PM CDT`) — clients stay timezone-math-free.
    /// `nil` when unscheduled.
    let startLabel: String?
    /// The next un-scored game, for the card's "Enter Game N result" deep link.
    /// `nil` when the board is decided but unposted, or the match isn't running.
    let nextGameNumber: Int?
    /// `nil` unless `state == .completed` — a live, scheduled or *voided* match
    /// has no outcome, and a `false` would claim the caller lost a match still
    /// being played, or one struck from the record entirely.
    let youWon: Bool?
    let owedAction: TournamentOwedAction?
}

/// One line of the panel's "Your matches" path — every fixture in this event the
/// caller is a side of, in draw order.
struct DashboardTournamentFixtureRow: Decodable, Equatable {
    /// e.g. `M2` — the fixture's ordinal within the caller's own schedule.
    let label: String
    let opponentUsername: String?
    let state: TournamentFixtureState
    /// The row's right-hand text, composed server-side because what belongs
    /// there changes with `state` (a result, "In progress", or a time and
    /// table). Printed verbatim rather than reassembled from optional fields.
    let detail: String
    /// `nil` for anything not yet decided.
    let youWon: Bool?
    let matchId: UUID?
}

/// One event of a live tournament the caller holds an active entry in — one tab
/// of the panel.
struct DashboardTournamentEvent: Decodable, Equatable, Identifiable {
    let id: UUID
    let name: String
    let drawType: TournamentDrawType
    /// Whether this event holds the caller's currently-live match — what puts
    /// the "Live" marker on the tab.
    let isLive: Bool
    let wins: Int
    let losses: Int
    /// The caller's 1-based rank in their pool. `nil` when the event has no
    /// standings yet (no draw cut, or a draw type with no results strategy),
    /// which is a fact, not a zero.
    let position: Int?
    /// How many players the position is out of.
    let fieldSize: Int
    /// e.g. `Group play` / `Group complete`.
    let stageLabel: String
    /// The caller's pool name, or `nil` for an un-pooled draw.
    let poolLabel: String?
    let match: DashboardTournamentMatch?
    let fixtures: [DashboardTournamentFixtureRow]
}

/// A live tournament the caller is playing in — the whole panel, one per
/// tournament, with one tab per event they entered.
struct DashboardTournament: Decodable, Equatable, Identifiable {
    let id: UUID
    let name: String
    /// e.g. `Riverside TTC · Jul 24` — venue and dates, composed server-side.
    let subtitle: String
    /// How many of the caller's matches in this tournament are being played
    /// right now. Drives the header's "N live now" pill; `0` hides it.
    let liveCount: Int
    let events: [DashboardTournamentEvent]
}
