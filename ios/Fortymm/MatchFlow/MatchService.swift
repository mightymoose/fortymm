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

    /// Propose a result (`POST /v1/matches/{id}/results`) — the first verb of
    /// the propose/accept negotiation — and return the resulting match. A solo
    /// or unrated match self-accepts and comes back `completed`; a rated
    /// two-player match leaves the proposal standing for the opponent to accept.
    /// `yourSideNumber` orients the entered scores (`a` = you, `b` = them) back
    /// to the canonical side-1/side-2 axis the API expects. A freshly created
    /// match puts the creator on side 1; resuming a match the viewer didn't
    /// create may put them on side 2, in which case the points are swapped.
    /// `supersedes` marks this posting as a correction of the standing proposal
    /// with that id (a counter, or a self-edit of the viewer's own posting);
    /// the server 409s if the proposal has moved on.
    func postResult(
        matchId: UUID, games: [Game], yourSideNumber: Int = 1,
        supersedes: UUID? = nil
    ) async throws -> FinalMatch {
        let payload = PostResultsBody(
            games: games.enumerated().compactMap { i, g in
                guard let sides = Self.sidePoints(g, yourSideNumber: yourSideNumber) else { return nil }
                return PostResultsBody.GameWrite(
                    gameNumber: i + 1,
                    side1Points: sides.side1,
                    side2Points: sides.side2
                )
            },
            supersedesResultId: supersedes
        )
        let details: MatchDetailsDTO = try await client.post(
            "/v1/matches/\(matchId.uuidString)/results", body: payload
        )
        return Self.finalMatch(from: details)
    }

    // MARK: Per-game scratchpad writes

    /// A successful score write came back without a score for the game we just
    /// wrote — a can't-happen shape the server never emits, deliberately
    /// distinct from `APIError` so a bug here can't masquerade as a real
    /// network/decoding failure.
    struct MissingScoreVersion: Error {}

    /// Create this game's score (`POST .../games/{n}/scores/new`) and return the
    /// new `version`, or the conflict body on a 409. Points are oriented exactly
    /// like `postResult` (`a` = you, `b` = them → side-1/side-2, swapped when the
    /// viewer is side 2). The success response is the full board, but this
    /// deliberately reads back only this game's version — refreshing the rest of
    /// the board is out of scope.
    func createGameScore(
        matchId: UUID, gameNumber: Int, game: Game, yourSideNumber: Int = 1
    ) async throws -> Result<Int, GameScoreConflictDTO> {
        guard let sides = Self.sidePoints(game, yourSideNumber: yourSideNumber) else {
            throw MissingScoreVersion()
        }
        let body = GameScoreWriteBody(
            side1Points: sides.side1,
            side2Points: sides.side2
        )
        let result: Result<MatchDetailsDTO, GameScoreConflictDTO> =
            try await client.sendExpectingConflict(
                "POST", "/v1/matches/\(matchId.uuidString)/games/\(gameNumber)/scores/new",
                body: body
            )
        return try Self.newVersion(from: result, gameNumber: gameNumber)
    }

    /// Update this game's score (`PUT .../games/{n}/scores`) as a conditional
    /// write against `expectedVersion`, returning the new `version` or the
    /// conflict body on a 409. Points are oriented like `createGameScore`.
    func updateGameScore(
        matchId: UUID, gameNumber: Int, game: Game, expectedVersion: Int,
        yourSideNumber: Int = 1
    ) async throws -> Result<Int, GameScoreConflictDTO> {
        guard let sides = Self.sidePoints(game, yourSideNumber: yourSideNumber) else {
            throw MissingScoreVersion()
        }
        let body = GameScoreUpdateBody(
            side1Points: sides.side1,
            side2Points: sides.side2,
            expectedVersion: expectedVersion
        )
        let result: Result<MatchDetailsDTO, GameScoreConflictDTO> =
            try await client.sendExpectingConflict(
                "PUT", "/v1/matches/\(matchId.uuidString)/games/\(gameNumber)/scores",
                body: body
            )
        return try Self.newVersion(from: result, gameNumber: gameNumber)
    }

    /// Delete this game's score (`DELETE .../games/{n}/scores`). The endpoint
    /// returns the refreshed board, deliberately ignored — clearing a scratch
    /// entry has no version to carry forward.
    func deleteGameScore(matchId: UUID, gameNumber: Int) async throws {
        let _: MatchDetailsDTO = try await client.delete(
            "/v1/matches/\(matchId.uuidString)/games/\(gameNumber)/scores"
        )
    }

    /// On success, pull the freshly written game's `version` out of the returned
    /// board (throwing `MissingScoreVersion` if it's absent); on 409, pass the
    /// conflict body straight through.
    private static func newVersion(
        from result: Result<MatchDetailsDTO, GameScoreConflictDTO>, gameNumber: Int
    ) throws -> Result<Int, GameScoreConflictDTO> {
        switch result {
        case let .success(details):
            guard let version = details.games
                .first(where: { $0.gameNumber == gameNumber })?.score?.version
            else { throw MissingScoreVersion() }
            return .success(version)
        case let .failure(conflict):
            return .failure(conflict)
        }
    }

    // MARK: Accept

    /// Accept the standing proposal (`POST /v1/matches/{id}/results/{resultId}/
    /// acceptance`) — the second verb of the negotiation. `resultId` is the
    /// concurrency token: it must be the current standing proposal's id, or the
    /// server 409s (the proposal moved on — superseded or already accepted).
    /// On success the match comes back `completed`.
    func acceptResult(matchId: UUID, resultId: UUID) async throws -> FinalMatch {
        let details: MatchDetailsDTO = try await client.post(
            "/v1/matches/\(matchId.uuidString)/results/\(resultId.uuidString)/acceptance"
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
    /// The global match feed, optionally narrowed by lifecycle `status` and a
    /// player-name search `query` (both server-side, mirroring the web `/matches`
    /// filters). Returns the rows plus the per-status counts that drive the tab
    /// badges.
    func listMatches(
        status: APIMatchStatus? = nil,
        query: String? = nil,
        page: Int = 1,
        pageSize: Int = 50
    ) async throws -> MatchListPage {
        var items: [URLQueryItem] = [
            URLQueryItem(name: "page", value: String(page)),
            URLQueryItem(name: "page_size", value: String(pageSize)),
        ]
        if let status {
            items.append(URLQueryItem(name: "status", value: status.rawValue))
        }
        if let query, !query.trimmingCharacters(in: .whitespaces).isEmpty {
            items.append(URLQueryItem(name: "q", value: query))
        }
        let response: MatchListResponseDTO = try await client.get("/v1/matches", query: items)
        return MatchListPage(
            items: response.items.map(Self.finalMatch(from:)),
            statusCounts: response.statusCounts
        )
    }

    // MARK: - DTO → view model

    private static func finalMatch(from d: MatchDetailsDTO) -> FinalMatch {
        common(
            id: d.id, status: d.status, statusLabel: d.statusLabel,
            league: d.league, sides: d.sides, bestOf: d.bestOf,
            createdAt: d.createdAt, canScore: d.canScore,
            canFinalize: d.canFinalize,
            ratedHint: d.affectsRating, games: d.games, h2h: d.headToHead,
            negotiation: d.negotiation
        )
    }

    private static func finalMatch(from r: MatchListRowDTO) -> FinalMatch {
        common(
            id: r.id, status: r.status, statusLabel: r.statusLabel,
            league: r.league, sides: r.sides, bestOf: r.bestOf,
            createdAt: r.createdAt, canScore: r.canScore,
            // The list row omits can_finalize; the detail refetch (on open) fills
            // in the authoritative value and surfaces the "Post result" path.
            canFinalize: false,
            // The list row carries the authoritative rated flag (rating_change is
            // omitted on list rows), so don't infer rated from a missing delta —
            // that mislabels finalized rated matches as "Friendly" (#453).
            ratedHint: r.affectsRating, games: nil, h2h: nil,
            negotiation: r.negotiation
        )
    }

    // MARK: Negotiation DTO → view model

    /// Project canonical side-1/side-2 points onto the viewer-relative axis
    /// (`a` = you, `b` = them) — the one place the read-orientation rule lives,
    /// used by the match-games and standing-result mappings and the score-entry
    /// conflict reducer.
    static func orientedGame(side1: Int, side2: Int, mineIsSide1: Bool) -> Game {
        mineIsSide1 ? Game(a: side1, b: side2) : Game(a: side2, b: side1)
    }

    /// The write-direction mirror of `orientedGame`: project the viewer-relative
    /// `a` = you / `b` = them points back onto the canonical side-1/side-2 axis
    /// the API expects (swapped when the viewer is side 2). `nil` when the game
    /// isn't fully entered, so callers skip it or reject the write. The single
    /// home for the write orientation, shared by `postResult` and the per-game
    /// scratchpad writes.
    static func sidePoints(_ game: Game, yourSideNumber: Int) -> (side1: Int, side2: Int)? {
        guard let a = game.a, let b = game.b else { return nil }
        let youAreSide1 = yourSideNumber != 2
        return youAreSide1 ? (a, b) : (b, a)
    }

    /// Map the wire negotiation onto the view model: re-orient the standing
    /// board so `a` = you, and pre-format the `corrected`-phase diff (canonical
    /// side-1–side-2, like the web's ScoreDiff).
    private static func negotiation(
        _ n: MatchNegotiationDTO, mineIsSide1: Bool
    ) -> MatchNegotiation {
        let standingGames: [Game] = (n.standingResult?.games ?? [])
            .sorted { $0.gameNumber < $1.gameNumber }
            .map { orientedGame(side1: $0.side1Points, side2: $0.side2Points, mineIsSide1: mineIsSide1) }
        func fmt(_ g: NegotiationGameDTO) -> String { "\(g.side1Points)–\(g.side2Points)" }
        let diff: [ScoreDiffEntry] = (n.diff ?? []).map { entry in
            ScoreDiffEntry(
                gameNumber: entry.gameNumber,
                old: entry.old.map(fmt),
                new: entry.new.map(fmt)
            )
        }
        return MatchNegotiation(
            viewerState: n.viewerState,
            standingResultId: n.standingResult?.id,
            standingGames: standingGames,
            diff: diff
        )
    }

    /// Shared builder for both the detail and list shapes. `mine` is the
    /// current user's side (falling back to side 1 for matches the viewer
    /// isn't in); all scores are projected so `a` = you, `b` = them.
    private static func common(
        id: UUID, status: APIMatchStatus, statusLabel: String,
        league: MatchLeagueDTO, sides: [MatchSideDTO], bestOf: Int,
        createdAt: Date, canScore: Bool, canFinalize: Bool,
        ratedHint: Bool?, games: [MatchGameDTO]?, h2h: H2HDTO?,
        negotiation negotiationDTO: MatchNegotiationDTO
    ) -> FinalMatch {
        let viewerIsParticipant = sides.contains(where: \.isCurrentUserSide)
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

        // Side-ordered players for the neutral list row — built straight from
        // the side, independent of the viewer-relative you/them projection, so a
        // spectator row shows both real participants rather than labelling side 1
        // "You". This projection is deliberately viewer-agnostic, so `you` stays
        // false; the viewer-relative `you`/`opponent` fields carry that flag
        // instead. A player-less side (solo opponent) reads as the Guest sentinel.
        func sidePlayer(_ side: MatchSideDTO?) -> MatchPlayer {
            guard let p = side?.players.first else { return .guest }
            return MatchPlayer(
                handle: p.username,
                initials: p.username.fmInitials,
                avatarColor: MatchPlayer.avatarColor(for: p.username),
                rating: side?.ratingChange?.before.map { Int($0.rounded()) } ?? 1500,
                userId: p.userId
            )
        }
        let side1 = sides.first { $0.sideNumber == 1 } ?? sides.first
        let side2 = sides.first { $0.sideNumber == 2 }

        // The resume board, enriched: each committed game keeps its scratchpad
        // version so the per-game write path can PUT-guard on it. Same sort and
        // compactMap as the plain `mappedGames` below, so the two carry the exact
        // same games in the same order — only `sync`/`version` is added.
        let scoredGames: [ScoredGame] = (games ?? [])
            .sorted { $0.gameNumber < $1.gameNumber }
            .compactMap { g in
                guard let s = g.score else { return nil }
                return ScoredGame(
                    points: orientedGame(
                        side1: s.side1Points, side2: s.side2Points, mineIsSide1: mineIsSide1
                    ),
                    sync: .saved(version: s.version)
                )
            }
        let mappedGames: [Game] = scoredGames.map(\.points)

        let decided = status == .completed
        let rated = ratedHint ?? (mine?.ratingChange != nil)
        let delta = mine?.ratingChange.map { Int($0.delta.rounded()) }
        // The negotiation block is populated on both the detail and list shapes,
        // so the sign-off flags (`awaitingConfirmation`, `canConfirm`) are
        // derived from it on `FinalMatch` itself — authoritative everywhere, no
        // games-won heuristic (which mis-read a rewound board as posted).
        let negotiation = Self.negotiation(negotiationDTO, mineIsSide1: mineIsSide1)

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
            // Rating delta is the viewer's own change — only meaningful when the
            // viewer actually played in this match.
            ratingDelta: (rated && decided && viewerIsParticipant) ? delta : nil,
            when: relativeWhen(createdAt),
            context: rated ? "Rated · \(league.name)" : "Casual",
            statusLabel: statusLabel,
            decided: decided,
            negotiation: negotiation,
            scoredGames: scoredGames,
            h2h: h2h.map { mapH2H($0, mineIsSide1: mineIsSide1) },
            sideA: sidePlayer(side1),
            sideB: (side2?.players.isEmpty ?? true) ? .guest : sidePlayer(side2),
            sideAGames: side1?.gamesWon ?? 0,
            sideBGames: side2?.gamesWon ?? 0,
            viewerIsParticipant: viewerIsParticipant,
            inProgress: status == .inProgress,
            // `canScore` is the server's authoritative "scores are editable"
            // signal — true whenever no result has been proposed (the
            // scratchpad is open), regardless of whether a next game remains.
            // `canResume` is built on it.
            canScore: canScore && viewerIsParticipant,
            canFinalize: canFinalize && viewerIsParticipant,
            yourSideNumber: mine?.sideNumber ?? 1
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
