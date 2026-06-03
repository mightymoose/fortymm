import Foundation

/// Mirror of the API's `DashboardResponse` (see `api/app/schemas/dashboard.py`),
/// which backs the dashboard's "Your game" widgets. Decoded with
/// `.convertFromSnakeCase`, so `recent_results` / `spark_data` / `my_rating_change`
/// arrive as `recentResults` / `sparkData` / `myRatingChange`.
struct DashboardResponse: Decodable {
    let scoreBanners: [DashboardScoreBanner]
    let nextMatch: DashboardNextMatch?
    let recentResults: [DashboardRecentResult]
    let rating: DashboardRating?
    let completedMatchCount: Int
}

struct DashboardScoreBanner: Decodable {
    let matchId: UUID
    let opponentUsername: String?
    let currentGameNumber: Int
}

struct DashboardNextMatch: Decodable {
    let matchId: UUID
    let opponentUsername: String?
    let bestOf: Int
    let createdAt: Date
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
