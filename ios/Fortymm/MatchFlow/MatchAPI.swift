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

/// Mirror of `app.models.match.MatchStatus`. Lenient: an unrecognised value
/// (e.g. a status added server-side later) decodes to `.unknown` rather than
/// throwing, so the app keeps rendering.
enum APIMatchStatus: String, Decodable {
    case pending
    case inProgress = "in_progress"
    case completed
    case disputed
    case voided
    case unknown

    init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = APIMatchStatus(rawValue: raw) ?? .unknown
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

struct RatingChangeDTO: Decodable {
    let before: Double?
    let after: Double
    let delta: Double
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
}

struct MatchGameDTO: Decodable {
    let gameNumber: Int
    let score: MatchScoreDTO?
}

struct MatchSignatureDTO: Decodable {
    let userId: UUID
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
    let canScore: Bool
    let canFinalize: Bool
    let canConfirm: Bool
    let signatures: [MatchSignatureDTO]
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
    /// The viewer can enter scores for this (live) match — drives the row's
    /// "Score" affordance.
    let canScore: Bool
    let canConfirm: Bool
}

struct MatchListResponseDTO: Decodable {
    let items: [MatchListRowDTO]
    let page: Int
    let pageSize: Int
    let total: Int
    /// Per-status totals for the filter tabs, keyed by the raw API status string
    /// ("pending", "in_progress", …). Honors the active `q` but not the status
    /// filter, so the counts stay stable as the user switches tabs.
    let statusCounts: [String: Int]
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
