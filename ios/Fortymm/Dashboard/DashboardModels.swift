import Foundation

/// Mirror of the API's `DashboardResponse` (see `api/app/schemas/dashboard.py`),
/// which backs the dashboard's "Your game" widgets. Decoded with
/// `.convertFromSnakeCase`, so `recent_results` / `spark_data` / `my_rating_change`
/// arrive as `recentResults` / `sparkData` / `myRatingChange`.
struct DashboardResponse: Decodable {
    /// The current user's most-urgent actionable matches, pre-ranked server-side
    /// by attention priority (see `api/app/dashboard.py`). Capped server-side, so
    /// this is NOT the full set — the UI renders the top few as rows and uses
    /// `attentionTotalCount` (not this array's length) for the footer overflow.
    let attention: [DashboardAttentionItem]
    /// Total actionable matches for the current user, counted server-side
    /// independently of the `attention` cap so the footer's "+N more" stays
    /// accurate however many there are.
    let attentionTotalCount: Int
    /// Matches that need *someone else's* move — a result we posted awaiting the
    /// opponent's sign-off, plus pending/scheduled matches. Footer text only;
    /// never a row.
    let waitingCount: Int
    let recentResults: [DashboardRecentResult]
    let rating: DashboardRating?
    let completedMatchCount: Int
}

/// The actionable bucket a match falls in for the current user, in priority
/// order (`dispute` > `review` > `score`). Mirrors the API's `AttentionKind`
/// (`api/app/schemas/dashboard.py`). An unknown future kind decodes to
/// `.unknown` so an older client doesn't fail the whole payload.
enum AttentionKind: String, Decodable {
    case dispute
    case review
    case score
    case unknown

    init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = AttentionKind(rawValue: raw) ?? .unknown
    }
}

/// One actionable row in the dashboard's "Needs your attention" panel,
/// classified server-side and current-user-aware. Mirror of the API's
/// `DashboardAttentionItem`. Carries only routing data — opponent handle and
/// the action — never scores.
struct DashboardAttentionItem: Decodable, Identifiable {
    let matchId: UUID
    let opponentUsername: String?
    let kind: AttentionKind
    /// `score` rows split rated-above-unrated by this flag; always true for
    /// `review`/`dispute` (both only arise on rated matches).
    let affectsRating: Bool
    /// The next un-scored game for a `score` row, used to deep-link straight
    /// into scoring. `nil` when the board is decided but unposted (route to
    /// match detail to post instead), and always `nil` for `review`/`dispute`.
    let currentGameNumber: Int?

    var id: UUID { matchId }
}

/// One row of the "Recent matches" table.
struct DashboardRecentResult: Decodable, Identifiable {
    let matchId: UUID
    let opponentUsername: String?
    let isWin: Bool
    let myGamesWon: Int
    let opponentGamesWon: Int
    let completedAt: Date
    let myRatingChange: RatingChange?

    var id: UUID { matchId }
}

struct RatingChange: Decodable {
    let before: Double?
    let after: Double
    let delta: Double
}

/// The "Current rating" card payload. Emitted only for automatic-strategy
/// leagues with a rated user — `nil` otherwise (manual league / unrated).
struct DashboardRating: Decodable {
    let leagueId: UUID
    let leagueName: String
    let strategyKey: String
    let current: Double
    let delta: Double
    let peak: Double
    let percentile: Int?
    let sparkData: [Double]
    let streak: DashboardStreak?
    let stats: [DashboardRatingStat]
}

struct DashboardStreak: Decodable {
    let kind: String   // "W" | "L"
    let n: Int
}

struct DashboardRatingStat: Decodable {
    let label: String
    let value: String   // pre-formatted server-side
}

extension DashboardRating {
    /// Human label for the rating strategy, mirroring `ratingStrategyLabel`
    /// in `web-client/src/components/dashboard/dashboard-page.tsx`.
    var strategyLabel: String {
        switch strategyKey {
        case "glicko2": return "Glicko-2"
        case "manual": return "Manual"
        default: return strategyKey
        }
    }
}
