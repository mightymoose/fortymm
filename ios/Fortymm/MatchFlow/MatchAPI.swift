import Foundation

/// Decodable/Encodable mirrors of the API's match + player schemas
/// (`api/app/schemas/match.py`, `api/app/players.py`, `api/app/dashboard.py`).
///
/// Response models decode with `.convertFromSnakeCase`, so `status_label`
/// arrives as `statusLabel` and `side_1_points` as `side1Points`. Request
/// bodies whose keys contain a digit segment (`side_1_points`) can't be
/// produced by `.convertToSnakeCase` from a camelCase name, so they carry
/// explicit snake-case `CodingKeys` (which pass through the encoder unchanged).

// MARK: - Status

/// A string-backed API enum that decodes leniently: an unrecognised value
/// (e.g. a case added server-side later) decodes to `.unknown` rather than
/// throwing, so the app keeps rendering.
protocol LenientRawDecodable: RawRepresentable, Decodable where RawValue == String {
    static var unknown: Self { get }
}

extension LenientRawDecodable {
    init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = Self(rawValue: raw) ?? .unknown
    }
}

/// Mirror of `app.models.match.MatchStatus`.
enum APIMatchStatus: String, LenientRawDecodable {
    case pending
    case inProgress = "in_progress"
    case completed
    case voided
    case unknown
}

/// Per-status match counts behind the filter-tab badges, framed by the closed
/// `APIMatchStatus` domain instead of raw strings.
///
/// The server sends `status_counts` as an *open* map keyed by the raw status
/// string (`{"pending": …, "in_progress": …, "completed": …, …}` — see
/// `MatchListResponse` in the OpenAPI schema; the count feed is dense, seeding
/// every status to 0).
///
/// `APIClient`'s shared decoder uses `.convertFromSnakeCase` — and whether that
/// strategy rewrites the keys *inside* a `[String: Int]` dictionary depends on
/// the device's Foundation: the objc-era `JSONDecoder` (iOS 17, our minimum
/// target) converts them (`in_progress` → `inProgress`), while swift-foundation
/// (iOS 18+) leaves them alone. The old string-keyed lookup
/// (`statusCounts["in_progress"]`) therefore read 0 on iOS 17 — the "Live badge
/// always 0" bug — and worked on iOS 18. We re-canonicalise decoded keys back to
/// snake_case at the boundary (idempotent on already-snake keys, so it's correct
/// on both), and expose only enum-keyed accessors so no caller can mis-key the
/// map again. Modelling the open dict (rather than a fixed field set) keeps the
/// "All" total faithful to every bucket the feed can show — including `voided` /
/// `disputed` / any status added server-side later.
struct StatusCounts: Decodable, Equatable {
    /// Counts keyed by canonical (snake_case) API status string.
    private let byStatus: [String: Int]

    /// Empty counts — the initial state before the first list fetch.
    static let empty = StatusCounts([:] as [APIMatchStatus: Int])

    /// Build directly from typed statuses (seed / preview / test construction).
    init(_ counts: [APIMatchStatus: Int]) {
        byStatus = Dictionary(
            counts.map { ($0.key.rawValue, $0.value) },
            uniquingKeysWith: { first, _ in first }
        )
    }

    init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode([String: Int].self)
        byStatus = Dictionary(
            raw.map { (Self.canonicalKey($0.key), $0.value) },
            uniquingKeysWith: { first, _ in first }
        )
    }

    /// The count feeding a tab: a specific status's bucket, or — for the "All"
    /// tab (`nil`) — the sum of *every* bucket the server sent, so voided /
    /// disputed / any future status the unfiltered feed still shows are counted.
    func count(for status: APIMatchStatus?) -> Int {
        guard let status else { return total }
        return byStatus[status.rawValue] ?? 0
    }

    /// Sum across every status bucket — the "All" badge.
    var total: Int { byStatus.values.reduce(0, +) }

    /// Invert `.convertFromSnakeCase` on a decoded key so it matches the
    /// server's snake_case status string. Idempotent on already-snake keys, so
    /// it's correct whether or not the decoder applied the strategy.
    private static func canonicalKey(_ key: String) -> String {
        var out = ""
        for ch in key {
            if ch.isUppercase {
                out.append("_")
                out.append(Character(ch.lowercased()))
            } else {
                out.append(ch)
            }
        }
        return out
    }
}

// MARK: - Shared nested types

struct MatchLeagueDTO: Decodable {
    let id: UUID
    let name: String
}

struct MatchPlayerDTO: Decodable {
    let userId: UUID
    let username: String
    let isCurrentUser: Bool
}

/// Mirror of `app.schemas.rating.RatingChange` (also `Generated/Types.swift`'s
/// `Components.Schemas.RatingChange`, which already has `delta: Double?` —
/// this hand-written DTO must stay at least as optional). Two distinct nulls
/// reach the client and they mean different things: a null `RatingChangeDTO?`
/// on `MatchSideDTO` is "this match moved no rating at all" (unrated,
/// undecided, or voided); a null `delta` *inside* a present change is "this is
/// the rating you got, and there was nothing before it to measure from" — a
/// player's first rated match ESTABLISHES a rating rather than MOVING one
/// (#952). `before` is null for the same reason. Decoding `delta` as
/// non-optional throws for the *entire* match-detail response on exactly that
/// payload (#1180) — the bug this DTO shape now guards against.
struct RatingChangeDTO: Decodable {
    let before: Double?
    let after: Double
    let delta: Double?
}

struct MatchSideDTO: Decodable {
    let sideNumber: Int
    let players: [MatchPlayerDTO]
    let gamesWon: Int
    let won: Bool?
    let isCurrentUserSide: Bool
    let ratingChange: RatingChangeDTO?
}

struct MatchScoreDTO: Decodable {
    let side1Points: Int
    let side2Points: Int
    let winnerSideNumber: Int
    // Optimistic-concurrency token from the API, decoded and used as the
    // expected-version token for per-game score writes (createGameScore /
    // updateGameScore in MatchService.swift).
    let version: Int
}

struct MatchGameDTO: Decodable {
    let gameNumber: Int
    let score: MatchScoreDTO?
}

// MARK: - Result negotiation (propose/accept)

/// Mirror of `app.schemas.match.ViewerState` — the viewer-relative phase of the
/// propose/accept negotiation.
enum ViewerStateDTO: String, LenientRawDecodable {
    /// No result posted yet — the match is still being scored.
    case live
    /// The viewer's side posted the standing result and owes nothing.
    case awaiting
    /// The opponent posted and the viewer has no prior proposal — the viewer
    /// should accept or suggest a correction.
    case review
    /// The opponent posted a correction over the viewer's own prior proposal.
    case corrected
    /// A result has been accepted; the match is settled.
    case `final`
    case unknown

    /// A proposal has been posted and is still being negotiated — the states
    /// where the board is no longer a live scratchpad but the match isn't
    /// settled either.
    var hasStandingProposal: Bool {
        switch self {
        case .awaiting, .review, .corrected: return true
        case .live, .final, .unknown: return false
        }
    }

    /// The viewer owes an accept-or-correct on the standing proposal: the
    /// opponent posted it (first posting → `review`; a correction over the
    /// viewer's own prior proposal → `corrected`). Matches the server's
    /// `your_turn`, which is set exactly for these two states.
    var viewerOwesResponse: Bool {
        switch self {
        case .review, .corrected: return true
        case .live, .awaiting, .final, .unknown: return false
        }
    }
}

/// One game of a proposed result (`NegotiationGame`), on the canonical
/// side-1/side-2 axis.
struct NegotiationGameDTO: Decodable {
    let gameNumber: Int
    let side1Points: Int
    let side2Points: Int
}

/// A proposed result (`NegotiationResult`) — an immutable snapshot of the board
/// as claimed by whoever submitted it. `id` doubles as the concurrency token
/// for `POST .../results/{id}/acceptance` and `supersedes_result_id`. The wire
/// shape also carries `submitted_by`/`submitted_at`; they're left undeclared
/// (JSONDecoder ignores them) so decoding never depends on fields the app
/// doesn't read — the failure mode that broke every match screen when
/// `signatures` was removed server-side.
struct NegotiationResultDTO: Decodable {
    let id: UUID
    let games: [NegotiationGameDTO]
}

/// One game the standing correction added, removed, or changed relative to the
/// viewer's prior proposal (`NegotiationDiffEntry`). A correction may add,
/// remove, or change games: `old == nil` means the game was added; `new == nil`
/// means it was removed. At least one is always present.
struct NegotiationDiffEntryDTO: Decodable {
    let gameNumber: Int
    let old: NegotiationGameDTO?
    let new: NegotiationGameDTO?
}

/// Mirror of `MatchNegotiation` — always present on both the detail and list
/// shapes. `diff` is only populated for the `corrected` state. The wire shape's
/// `your_turn` and `prior_result` are left undeclared: `your_turn` is fully
/// implied by `viewer_state` (review/corrected), and nothing reads the prior
/// result (the diff is server-computed).
struct MatchNegotiationDTO: Decodable {
    let viewerState: ViewerStateDTO
    let standingResult: NegotiationResultDTO?
    let diff: [NegotiationDiffEntryDTO]?
}

struct H2HMeetingDTO: Decodable {
    let completedAt: Date
    let side1GamesWon: Int
    let side2GamesWon: Int
    let winnerSideNumber: Int?
}

struct H2HDTO: Decodable {
    let totalMeetings: Int
    let side1Wins: Int
    let side2Wins: Int
    let recentMeetings: [H2HMeetingDTO]
}

// MARK: - Match details (BFF for detail + scoring routes)

struct MatchDetailsDTO: Decodable {
    let id: UUID
    let status: APIMatchStatus
    let statusLabel: String
    let league: MatchLeagueDTO
    let bestOf: Int
    let gamesToWin: Int
    let affectsRating: Bool
    let createdAt: Date
    let sides: [MatchSideDTO]
    let games: [MatchGameDTO]
    /// Also `true` for the tournament director on a called, unresolved match
    /// even when the director isn't a participant (#1523) — this flag alone is
    /// **not** "viewer is a participant". `MatchService.common` ANDs it with
    /// `sides.contains(where: \.isCurrentUserSide)` before it reaches a view,
    /// so the participant-shaped score entry screen stays out of reach for a
    /// director. iOS has no director scoring surface, by design.
    let canScore: Bool
    let canFinalize: Bool
    let negotiation: MatchNegotiationDTO
    let headToHead: H2HDTO?
}

// MARK: - Match list (BFF for /matches)

struct MatchListRowDTO: Decodable {
    let id: UUID
    let status: APIMatchStatus
    let statusLabel: String
    let league: MatchLeagueDTO
    let sides: [MatchSideDTO]
    let bestOf: Int
    /// Whether the match counts toward ratings. Authoritative (from match
    /// settings), so the row labels rated vs. friendly without needing a
    /// rating delta — list rows omit `rating_change`.
    let affectsRating: Bool
    let createdAt: Date
    /// Next game to score; nil once every game is scored or the match is
    /// finalized. Game rows are created lazily, so this is a number, not an id.
    let currentGameNumber: Int?
    /// The viewer can enter scores for this (live) match. Also `true` for the
    /// tournament director on a called, unresolved match even when the
    /// director isn't a participant (#1523) — see the note on
    /// `MatchDetailsDTO.canScore`. `MatchService.common` ANDs this with side
    /// membership before it drives the row's "Score" affordance, so it does
    /// not, by itself, mean "viewer is a participant".
    let canScore: Bool
    /// Viewer-relative negotiation state — populated on list rows too (unlike
    /// the old `signatures` field), so the row-level "your turn" affordances
    /// are authoritative without a detail fetch.
    let negotiation: MatchNegotiationDTO
}

struct MatchListResponseDTO: Decodable {
    let items: [MatchListRowDTO]
    let page: Int
    let pageSize: Int
    let total: Int
    /// Per-status totals for the filter tabs, keyed by the raw API status string
    /// ("pending", "in_progress", …). Honors the active `q` but not the status
    /// filter, so the counts stay stable as the user switches tabs.
    let statusCounts: StatusCounts
}

// MARK: - Players (opponent picker)

struct PlayerReadDTO: Decodable {
    let id: UUID
    let username: String
    let rating: Double?
}

// MARK: - Request bodies

struct CreateMatchBody: Encodable {
    let opponentUserId: UUID?   // nil ⇒ solo match
    let bestOf: Int
    let rated: Bool
    // opponentUserId → opponent_user_id, bestOf → best_of via convertToSnakeCase.
}

struct PostResultsBody: Encodable {
    let games: [GameWrite]
    /// The standing result this posting supersedes (a correction/counter).
    /// `nil` on the first proposal; otherwise must equal the current standing
    /// result's id or the server 409s with the moved-on negotiation state.
    /// supersedesResultId → supersedes_result_id via convertToSnakeCase.
    var supersedesResultId: UUID? = nil

    struct GameWrite: Encodable {
        let gameNumber: Int
        let side1Points: Int
        let side2Points: Int

        // Digit-segment keys: spell them out so they survive the encoder
        // unchanged instead of becoming `side1_points`.
        enum CodingKeys: String, CodingKey {
            case gameNumber = "game_number"
            case side1Points = "side_1_points"
            case side2Points = "side_2_points"
        }
    }
}

/// Body for `POST .../games/{n}/scores/new` (`app.schemas.match.MatchGameScoreWrite`).
/// Creates a game's score; the success response is the full `MatchDetailsDTO` (201).
struct GameScoreWriteBody: Encodable {
    let side1Points: Int
    let side2Points: Int

    // Digit-segment keys: spell them out so they survive the encoder
    // unchanged instead of becoming `side1_points`.
    enum CodingKeys: String, CodingKey {
        case side1Points = "side_1_points"
        case side2Points = "side_2_points"
    }
}

/// Body for `PUT .../games/{n}/scores` (`app.schemas.match.MatchGameScoreUpdate`).
/// A conditional write: `expectedVersion` is the `MatchScoreDTO.version` the
/// caller last read, so a concurrent save 409s rather than being clobbered.
struct GameScoreUpdateBody: Encodable {
    let side1Points: Int
    let side2Points: Int
    let expectedVersion: Int

    // Digit-segment keys: spell them out so they survive the encoder unchanged.
    enum CodingKeys: String, CodingKey {
        case side1Points = "side_1_points"
        case side2Points = "side_2_points"
        case expectedVersion = "expected_version"
    }
}

/// 409 body for a rejected conditional score write
/// (`app.schemas.match.MatchGameScoreConflict`). `committedScore` is the row as
/// it actually stands now (`committed_score`, decoded via `.convertFromSnakeCase`).
/// Conforms to `Error` so it can ride as the `Failure` of the `Result` that
/// `APIClient.sendExpectingConflict` (and the `MatchService` score verbs) hand
/// back — `Swift.Result` requires its failure type to be an `Error`.
struct GameScoreConflictDTO: Decodable, Error {
    let message: String
    let committedScore: MatchScoreDTO?
}
