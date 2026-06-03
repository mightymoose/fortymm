import Foundation

/// The match flow's gateway to the API. Wraps `APIClient` with the specific
/// match/player endpoints and maps the server's perspective-neutral DTOs into
/// the view models (`MatchPlayer`, `Game`, `FinalMatch`) the SwiftUI screens
/// already render — so the existing UI is fed real data with minimal churn.
struct MatchService {
    static let shared = MatchService()

    private let client: APIClient
    init(client: APIClient = .shared) { self.client = client }

    // MARK: Opponent picker

    /// Recent opponents for the picker grid (`GET /v1/players/recent`).
    func recentPlayers(limit: Int = 6) async throws -> [MatchPlayer] {
        let dtos: [PlayerReadDTO] = try await client.get(
            "/v1/players/recent",
            query: [URLQueryItem(name: "limit", value: String(limit))]
        )
        return dtos.map(MatchPlayer.init(api:))
    }

    /// Typeahead opponent search (`GET /v1/players/search`).
    func searchPlayers(_ query: String, limit: Int = 12) async throws -> [MatchPlayer] {
        let trimmed = query.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty else { return [] }
        let dtos: [PlayerReadDTO] = try await client.get(
            "/v1/players/search",
            query: [
                URLQueryItem(name: "q", value: trimmed),
                URLQueryItem(name: "limit", value: String(limit)),
            ]
        )
        return dtos.map(MatchPlayer.init(api:))
    }

    // MARK: Create + score

    /// Create a match and return its id. A nil opponent ⇒ solo (always unrated).
    func createMatch(opponent: MatchPlayer?, bestOf: Int, rated: Bool) async throws -> UUID {
        let body = CreateMatchBody(
            opponentUserId: opponent?.userId,
            bestOf: bestOf,
            rated: opponent == nil ? false : rated
        )
        let details: MatchDetailsDTO = try await client.post("/v1/matches", body: body)
        return details.id
    }

    /// Post the canonical result (`POST /v1/matches/{id}/results`) and return
    /// the resulting match. For a solo match this comes back `completed`; for a
    /// two-player match it stays awaiting the opponent's confirmation.
    func postResult(matchId: UUID, games: [Game]) async throws -> FinalMatch {
        let payload = PostResultsBody(games: games.enumerated().compactMap { i, g in
            guard let a = g.a, let b = g.b else { return nil }
            // `a` is always the current user's (side-1) points: a freshly
            // created match puts the creator on side 1.
            return PostResultsBody.GameWrite(
                gameNumber: i + 1, side1Points: a, side2Points: b
            )
        })
        let details: MatchDetailsDTO = try await client.post(
            "/v1/matches/\(matchId.uuidString)/results", body: payload
        )
        return Self.finalMatch(from: details)
    }

    // MARK: Confirm / dispute

    /// Sign off on a posted result (`POST /v1/matches/{id}/confirmation`). Once
    /// every side has signed the match comes back `completed`; until then it
    /// stays awaiting the remaining sign-off.
    func confirmMatch(_ id: UUID) async throws -> FinalMatch {
        let details: MatchDetailsDTO = try await client.post(
            "/v1/matches/\(id.uuidString)/confirmation"
        )
        return Self.finalMatch(from: details)
    }

    /// Reject a posted result (`POST /v1/matches/{id}/dispute`). Clears the
    /// signatures and rewinds the result, returning the match to `in_progress`.
    func disputeMatch(_ id: UUID) async throws -> FinalMatch {
        let details: MatchDetailsDTO = try await client.post(
            "/v1/matches/\(id.uuidString)/dispute"
        )
        return Self.finalMatch(from: details)
    }

    // MARK: Read

    /// Full detail for one match (`GET /v1/matches/{id}`).
    func matchDetails(_ id: UUID) async throws -> FinalMatch {
        let details: MatchDetailsDTO = try await client.get("/v1/matches/\(id.uuidString)")
        return Self.finalMatch(from: details)
    }

    /// The current user's matches, newest first (`GET /v1/matches`).
    func listMatches(page: Int = 1, pageSize: Int = 50) async throws -> [FinalMatch] {
        let response: MatchListResponseDTO = try await client.get(
            "/v1/matches",
            query: [
                URLQueryItem(name: "page", value: String(page)),
                URLQueryItem(name: "page_size", value: String(pageSize)),
            ]
        )
        return response.items.map(Self.finalMatch(from:))
    }

    /// Current user's season record for the Matches-tab header. The session
    /// doesn't expose the user's id, so we discover it from their own matches
    /// (they appear as `is_current_user` on every row) and fetch the player
    /// profile. Returns nil when the user has no matches yet (nothing to show).
    func myRecord() async throws -> MyRecord? {
        let response: MatchListResponseDTO = try await client.get(
            "/v1/matches",
            query: [URLQueryItem(name: "page_size", value: "1")]
        )
        let myId = response.items
            .flatMap(\.sides).flatMap(\.players)
            .first(where: \.isCurrentUser)?.userId
        guard let myId else { return nil }
        let player: PlayerDetailDTO = try await client.get("/v1/players/\(myId.uuidString)")
        return MyRecord(
            wins: player.wins,
            losses: player.losses,
            rating: player.rating.map { Int($0.rounded()) },
            form: player.form
        )
    }

    // MARK: - DTO → view model

    private static func finalMatch(from d: MatchDetailsDTO) -> FinalMatch {
        common(
            id: d.id, status: d.status, statusLabel: d.statusLabel,
            league: d.league, sides: d.sides, bestOf: d.bestOf,
            createdAt: d.createdAt, canConfirm: d.canConfirm,
            ratedHint: d.affectsRating, games: d.games, h2h: d.headToHead
        )
    }

    private static func finalMatch(from r: MatchListRowDTO) -> FinalMatch {
        common(
            id: r.id, status: r.status, statusLabel: r.statusLabel,
            league: r.league, sides: r.sides, bestOf: r.bestOf,
            createdAt: r.createdAt, canConfirm: r.canConfirm,
            ratedHint: nil, games: nil, h2h: nil
        )
    }

    /// Shared builder for both the detail and list shapes. `mine` is the
    /// current user's side (falling back to side 1 for matches the viewer
    /// isn't in); all scores are projected so `a` = you, `b` = them.
    private static func common(
        id: UUID, status: APIMatchStatus, statusLabel: String,
        league: MatchLeagueDTO, sides: [MatchSideDTO], bestOf: Int,
        createdAt: Date, canConfirm: Bool, ratedHint: Bool?,
        games: [MatchGameDTO]?, h2h: H2HDTO?
    ) -> FinalMatch {
        let mine = sides.first(where: \.isCurrentUserSide) ?? sides.first
        let theirs = sides.first { $0.sideNumber != mine?.sideNumber }
        let mineIsSide1 = (mine?.sideNumber ?? 1) == 1
        let solo = theirs?.players.isEmpty ?? true

        let myName = mine?.players.first?.username ?? "You"
        let theirName = theirs?.players.first?.username ?? "Opponent"
        let you = MatchPlayer(
            handle: myName,
            initials: myName.fmInitials,
            avatarColor: .slate,
            rating: mine?.ratingChange?.before.map { Int($0.rounded()) } ?? 1500,
            you: true,
            userId: mine?.players.first?.userId
        )
        let opponent: MatchPlayer = solo
            ? .guest
            : MatchPlayer(
                handle: theirName,
                initials: theirName.fmInitials,
                avatarColor: MatchPlayer.avatarColor(for: theirName),
                rating: theirs?.ratingChange?.before.map { Int($0.rounded()) } ?? 1500,
                userId: theirs?.players.first?.userId
            )

        let mappedGames: [Game] = (games ?? [])
            .sorted { $0.gameNumber < $1.gameNumber }
            .compactMap { g in
                guard let s = g.score else { return nil }
                return mineIsSide1
                    ? Game(a: s.side1Points, b: s.side2Points)
                    : Game(a: s.side2Points, b: s.side1Points)
            }

        let decided = status == .completed
        let rated = ratedHint ?? (mine?.ratingChange != nil)
        let delta = mine?.ratingChange.map { Int($0.delta.rounded()) }
        let resultPosted = (mine?.gamesWon ?? 0) + (theirs?.gamesWon ?? 0) > 0
        let awaitingConfirmation = status == .inProgress && resultPosted

        return FinalMatch(
            id: id.uuidString,
            you: you,
            opponent: opponent,
            solo: solo,
            games: mappedGames,
            bestOf: bestOf,
            rated: rated,
            setsWon: SetScore(a: mine?.gamesWon ?? 0, b: theirs?.gamesWon ?? 0),
            win: mine?.won ?? false,
            ratingDelta: (rated && decided) ? delta : nil,
            when: relativeWhen(createdAt),
            context: rated ? "Rated · \(league.name)" : "Casual",
            statusLabel: statusLabel,
            decided: decided,
            awaitingConfirmation: awaitingConfirmation,
            canConfirm: canConfirm,
            h2h: h2h.map { mapH2H($0, mineIsSide1: mineIsSide1) }
        )
    }

    private static func mapH2H(_ h: H2HDTO, mineIsSide1: Bool) -> MatchH2H {
        MatchH2H(
            youWins: mineIsSide1 ? h.side1Wins : h.side2Wins,
            themWins: mineIsSide1 ? h.side2Wins : h.side1Wins,
            meetings: h.recentMeetings.map { m in
                let myGames = mineIsSide1 ? m.side1GamesWon : m.side2GamesWon
                let theirGames = mineIsSide1 ? m.side2GamesWon : m.side1GamesWon
                let mySide = mineIsSide1 ? 1 : 2
                return MatchH2H.Meeting(
                    when: relativeWhen(m.completedAt),
                    res: "\(myGames)-\(theirGames)",
                    win: m.winnerSideNumber == mySide
                )
            }
        )
    }

    // MARK: Dates

    /// Reused across every row/meeting render — a `DateFormatter` is expensive
    /// to build, so keep one.
    private static let dayFormatter: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "EEE MMM d"
        return f
    }()

    /// Short, human "when" label for a match timestamp.
    static func relativeWhen(_ date: Date) -> String {
        let cal = Calendar.current
        if cal.isDateInToday(date) {
            let mins = Int(Date().timeIntervalSince(date) / 60)
            if mins < 1 { return "Just now" }
            if mins < 60 { return "\(mins)m ago" }
            return "Today"
        }
        if cal.isDateInYesterday(date) { return "Yesterday" }
        return dayFormatter.string(from: date)
    }
}

/// Current user's season record, derived from their player profile.
struct MyRecord {
    let wins: Int
    let losses: Int
    let rating: Int?
    let form: String   // newest-first "WLWWL"

    var total: Int { wins + losses }
    var winRate: Int { total == 0 ? 0 : Int((Double(wins) / Double(total) * 100).rounded()) }

    /// Leading run of the form string, e.g. "WWL" → "2W". "—" when no matches.
    var streak: String {
        guard let first = form.first else { return "—" }
        let n = form.prefix { $0 == first }.count
        return "\(n)\(first)"
    }
}
