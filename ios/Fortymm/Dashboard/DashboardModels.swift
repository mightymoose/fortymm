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
    /// opponent's acceptance, plus pending/scheduled matches. Footer text only;
    /// never a row.
    let waitingCount: Int
    let recentResults: [DashboardRecentResult]
    /// ALWAYS emitted for a signed-in user (see `DashboardRating`'s doc comment) —
    /// no longer `| None` server-side, per ADR 20260725. Its `state` says which of
    /// four stories the card tells; only `.rated` carries the rating payload.
    let rating: DashboardRating
    let completedMatchCount: Int
    /// Every LIVE tournament the caller holds an active entry in, newest first —
    /// the panel that sits at the very top of the dashboard while they're playing
    /// one. Empty (and the panel absent) the rest of the time, which is almost
    /// always: a tournament is only `live` for the day or two it's being run.
    ///
    /// It rides on this payload rather than an endpoint of its own because the
    /// panel loads with the page (the BFF rule in the root `CLAUDE.md`); its tabs
    /// switch between events that are all already here, so no tab costs a
    /// round-trip.
    ///
    /// Optional because the field carries a server-side default and is therefore
    /// *not required* in the OpenAPI schema (see `Generated/Types.swift`), so an
    /// API older than the one that introduced it simply omits the key — which
    /// must leave the rest of the dashboard decoding, not blank the screen.
    /// `projectTournamentPanels` takes the optional directly and reads a missing
    /// array the same as an empty one: no panel.
    let tournaments: [DashboardTournament]?
}

/// The actionable bucket a match falls in for the current user, in priority
/// order (`review` > `score`). Mirrors the API's `AttentionKind`
/// (`api/app/schemas/dashboard.py`). An unknown future kind decodes to
/// `.unknown` so an older client doesn't fail the whole payload.
enum AttentionKind: String, Decodable {
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
    /// `review` (only arises on rated matches).
    let affectsRating: Bool
    /// The next un-scored game for a `score` row, used to deep-link straight
    /// into scoring. `nil` when the board is decided but unposted (route to
    /// match detail to post instead), and always `nil` for `review`.
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

/// What one completed match did to the player's rating — and there are two kinds
/// of that. Mirror of the API's `RatingChange` (`api/app/schemas/rating.py`).
struct RatingChange: Decodable {
    /// `nil` == the player was UNRATED going in; this match is what gave them a
    /// rating. Not "unknown", and not zero.
    let before: Double?
    let after: Double
    /// How far the rating MOVED, or `nil` when it was ESTABLISHED rather than
    /// moved (the player's first rated match).
    ///
    /// Optional because the API's `delta` is a computed `float | None` (see
    /// `Generated/Types.swift`, `RatingChange.delta: Swift.Double?`) and the key
    /// is always PRESENT on the wire carrying an explicit `null`. Declaring it
    /// non-optional threw `valueNotFound` and failed the decode of the WHOLE
    /// `DashboardResponse` — a blank dashboard, not a degraded row — for every
    /// player whose recent matches include their first rated one.
    ///
    /// Readers must render *absence* (no signed number, no tone), never a
    /// fabricated `+0`: a zero claims a rated match moved the rating by nothing,
    /// which is a different and false statement (#952).
    let delta: Double?
}

/// WHICH rating story the card tells — mirrors the API's `DashboardRatingState`
/// (`api/app/schemas/dashboard.py`, ADR 20260725). A `nil`/absent `rating` used to
/// collapse three distinct non-rated facts into one signal; the state names the
/// situation so the client can say the true thing per arm instead of one
/// one-string-fits-all fallback. `unknown` is the forward-compat landing pad for a
/// state added after this build shipped — treated the same as `.notRatedLeague`
/// by call sites, mirroring the web's fallback.
enum DashboardRatingState: String, LenientRawDecodable {
    /// Has a rating: the value + delta, plus the rank-or-percentile line below.
    case rated = "RATED"
    /// In an automatic-strategy league but hasn't finished a rated match yet.
    case unrated = "UNRATED"
    /// Manual-strategy league whose external ratings haven't been imported yet.
    case awaitingImport = "AWAITING_IMPORT"
    /// Not a member of any rated league at all.
    case notRatedLeague = "NOT_RATED_LEAGUE"
    case unknown
}

/// The "Current rating" card payload — ALWAYS emitted for a signed-in user (the
/// parent `DashboardResponse.rating` is no longer optional). `state` says which
/// of four stories the card tells; only the `.rated` arm carries the payload
/// below (`current` / `delta` / `peak` / the rank-or-percentile line /
/// `sparkData` / `streak` / `stats`) — every other arm sends `null` for them, so
/// they're optional here even though `DashboardRatingCard` only ever renders for
/// `.rated` (see `DashboardView.yourGame`).
struct DashboardRating: Decodable {
    let state: DashboardRatingState
    /// The league context. Present for `.rated` / `.unrated` / `.awaitingImport`;
    /// `nil` for `.notRatedLeague` (there is no league to name).
    let leagueId: UUID?
    let leagueName: String?
    let strategyKey: String?
    /// The headline rating — `nil` on every non-`.rated` arm.
    let current: Double?
    /// What the player's last rated match did to them — the "+12 last match"
    /// chip. `nil` means THERE IS NO MOVE TO REPORT and the card must render
    /// nothing (no chip, no arrow, no tone) rather than a zero: either that
    /// match ESTABLISHED this rating instead of moving it, or no rated match
    /// lies behind the current value at all (a `manual` override / `import`).
    /// Also `nil` on every non-`.rated` arm.
    ///
    /// Optional for the same wire reason as `RatingChange.delta` — the API sends
    /// `float | None` (`Generated/Types.swift`) with the key always present — and
    /// it is a SECOND, independent decode blocker: `recentResults` is decoded
    /// first, so its failure masked this one entirely.
    let delta: Double?
    /// `nil` on every non-`.rated` arm — a peak is a rating they held, and they
    /// hold none.
    let peak: Double?
    /// "Top N%" — only once the rated population clears the server's threshold.
    /// Below that the card shows `rank`/`population` instead; `nil` on every
    /// non-`.rated` arm too.
    let percentile: Int?
    /// The player's 1-based position among the league's rated members, and how
    /// many rated members there are — the fallback "#N of M" line when
    /// `percentile` is suppressed. `nil` on every non-`.rated` arm.
    let rank: Int?
    let population: Int?
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
    /// in `web-client/src/components/dashboard/your-game-row.tsx`. `nil` when
    /// `strategyKey` is `nil` (any non-`.rated`/`.unrated`/`.awaitingImport`
    /// arm), so the subtitle can fall back to a bare window instead of a label.
    var strategyLabel: String? {
        guard let strategyKey else { return nil }
        switch strategyKey {
        case "glicko2": return "Glicko-2"
        case "manual": return "Manual"
        default: return strategyKey
        }
    }
}
