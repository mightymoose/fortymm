import SwiftUI

// MARK: - Player

/// A player in the match flow. `you` marks the signed-in player (orange avatar).
struct MatchPlayer: Identifiable, Hashable {
    var id: String { userId?.uuidString ?? handle }
    let handle: String
    let initials: String
    var avatarColor: AvatarColor = .slate
    var rating: Int = 1500
    var you: Bool = false
    /// The API user id, present for players that came from the server. Drives
    /// `opponent_user_id` on match creation; nil for the solo "Guest" sentinel.
    var userId: UUID? = nil

    /// The "Guest" placeholder shown on the opponent side of a solo match.
    static let guest = MatchPlayer(handle: "Guest", initials: "GU", avatarColor: .slate)

    /// Build a picker/opponent player from an API `PlayerRead`, deriving the
    /// initials and avatar colour (the API carries neither) deterministically
    /// from the username so a given handle always looks the same.
    init(api: PlayerReadDTO) {
        self.handle = api.username
        self.initials = api.username.fmInitials
        self.avatarColor = MatchPlayer.avatarColor(for: api.username)
        self.rating = api.rating.map { Int($0.rounded()) } ?? 1500
        self.you = false
        self.userId = api.id
    }

    /// Memberwise init kept available alongside the `api:` convenience init.
    init(handle: String, initials: String, avatarColor: AvatarColor = .slate,
         rating: Int = 1500, you: Bool = false, userId: UUID? = nil) {
        self.handle = handle
        self.initials = initials
        self.avatarColor = avatarColor
        self.rating = rating
        self.you = you
        self.userId = userId
    }

    /// Stable palette pick from the handle's code points (cosmetic only).
    static func avatarColor(for handle: String) -> AvatarColor {
        let palette: [AvatarColor] = [.purple, .green, .teal, .blue, .magenta, .slate]
        let sum = handle.unicodeScalars.reduce(0) { $0 + Int($1.value) }
        return palette[sum % palette.count]
    }
}

/// Fixed avatar palette ported from the prototype (`AV_COLORS`). `you` players
/// render with the orange gradient instead of one of these.
enum AvatarColor: Hashable {
    case purple, green, teal, blue, magenta, slate

    var color: Color {
        switch self {
        case .purple:  return Color(hex: 0x6D5BA6)
        case .green:   return Color(hex: 0x3E7D5A)
        case .teal:    return Color(hex: 0x2F7E78)
        case .blue:    return Color(hex: 0x4A5BA6)
        case .magenta: return Color(hex: 0x8A4A7A)
        case .slate:   return Color(hex: 0x404A60)
        }
    }
}

// MARK: - Config

/// Built on the New match screen. `opponent == nil` ⇒ solo match (rated forced off).
struct MatchConfig {
    var opponent: MatchPlayer?
    var bestOf: Int = 5          // 1 | 3 | 5 | 7
    var rated: Bool = false

    var isSolo: Bool { opponent == nil }
}

// MARK: - Game / Match

/// One game. `a` = you, `b` = opponent. `nil` = not yet entered.
struct Game: Hashable {
    var a: Int?
    var b: Int?
}

// MARK: - Result negotiation (view model)

/// One changed game between the viewer's prior proposal and the standing
/// correction, pre-formatted for display. Scores are canonical side-1–side-2,
/// matching the web's `ScoreDiff` rendering.
struct ScoreDiffEntry: Identifiable {
    let gameNumber: Int
    /// "11–7" as previously proposed; nil when the correction added this game.
    let old: String?
    let new: String
    var id: Int { gameNumber }
}

/// The negotiation state the detail/list screens act on: which phase the
/// viewer is in (the lenient DTO enum, used directly like `APIMatchStatus`),
/// the standing proposal's id (the acceptance / supersedes token), its board
/// (viewer-oriented, for seeding a correction), and the server-computed diff
/// shown in the `corrected` phase.
struct MatchNegotiation {
    let viewerState: ViewerStateDTO
    let standingResultId: UUID?
    /// The standing proposal's games with `a` = you, `b` = them — the immutable
    /// snapshot a correction board is seeded from (mirroring the web's
    /// correction entry, which seeds from `standing_result`, not the live
    /// scratchpad).
    let standingGames: [Game]
    let diff: [ScoreDiffEntry]
}

/// A finished, posted match — the shape the detail screen and matches list read.
struct FinalMatch: Identifiable {
    let id: String
    let you: MatchPlayer
    let opponent: MatchPlayer
    let solo: Bool
    let games: [Game]
    let bestOf: Int
    let rated: Bool
    let setsWon: SetScore
    let win: Bool
    let ratingDelta: Int?
    let when: String
    let context: String
    // --- server-backed extras (defaulted so the seed/local builders still
    // compile; populated when the match comes from the API) ---
    /// User-facing status, e.g. "Final" / "Awaiting acceptance" / "Live".
    var statusLabel: String = "Final"
    /// True once the result is official (match completed). When false, the
    /// posted result is still awaiting the opponent's acceptance, so the
    /// rating change is not yet real.
    var decided: Bool = true
    /// The viewer-relative negotiation state, when the match came from the API
    /// (nil only for seed/preview builders). Carries the acceptance token, the
    /// standing board for corrections, and the `corrected`-phase diff — and is
    /// the single source the derived flags below read, so they can't drift
    /// from it.
    var negotiation: MatchNegotiation? = nil

    /// True when a result has been posted but the match isn't decided yet — i.e.
    /// it's genuinely awaiting acceptance. Distinct from `!decided`, which is
    /// also true for a freshly-created *live* match that has no posted result.
    var awaitingAcceptance: Bool {
        inProgress && negotiation?.viewerState.hasStandingProposal == true
    }
    /// The current user owes an accept-or-correct on the standing proposal
    /// (negotiation `review` or `corrected` — the states where the opponent
    /// posted and it's the viewer's turn).
    var canAccept: Bool {
        viewerIsParticipant && negotiation?.viewerState.viewerOwesResponse == true
    }
    /// Server head-to-head, when the detail BFF provided it.
    var h2h: MatchH2H? = nil
    // --- neutral, side-ordered view (for the matches list, which is a global
    // feed where the viewer often isn't a participant). `you`/`opponent`/`win`
    // above are the viewer-relative projection used by the detail screen; the
    // fields below are framed by side number instead so a row can show *both*
    // participants without pretending side 1 is the viewer. ---
    /// Side 1 and side 2 players, in canonical side-number order.
    var sideA: MatchPlayer = MatchSeed.me
    var sideB: MatchPlayer = .guest
    /// Games won by side 1 / side 2.
    var sideAGames: Int = 0
    var sideBGames: Int = 0
    /// True when the signed-in user is on one of the sides. When false the row
    /// is a spectator view: the W/L badge and rating delta don't apply.
    var viewerIsParticipant: Bool = true
    /// True while the match is live (`in_progress`) — not yet decided or voided.
    var inProgress: Bool = false
    /// The viewer can enter/continue scores: a participant on a live match with
    /// no posted result currently awaiting acceptance. Drives the "resume
    /// scoring" affordances on the detail, list, and dashboard surfaces.
    var canScore: Bool = false
    /// The saved games already form a decided, valid match and the viewer can
    /// post the result. True for a match scored to a decision but never posted
    /// (e.g. a web user entered the games then left). `canScore` is *also*
    /// true here — the board stays a scratchpad until a result is proposed —
    /// so the detail screen offers both "Post result" and "Edit scores".
    var canFinalize: Bool = false
    /// The viewer's side number (1 or 2). Used to orient entered scores back to
    /// the canonical side-1/side-2 axis when resuming a match the viewer didn't
    /// create. Defaults to side 1 (the match creator).
    var yourSideNumber: Int = 1

    /// The viewer can resume entering / editing scores. Relies solely on the
    /// server's `canScore`, which is false once a result has been proposed (the
    /// scratchpad closes; changes then flow through the propose/accept
    /// negotiation). Single source of truth for the "Score" affordances on the
    /// list, detail, and dashboard.
    var canResume: Bool { canScore && inProgress }

    /// Context for resuming live scoring, or `nil` when the viewer can't (or
    /// needn't) continue this match. Built from the viewer-relative projection
    /// so `you` stays side `yourSideNumber` and the entered games re-orient
    /// correctly on post.
    var resumeContext: ResumeScoring? {
        guard canResume, let uuid = UUID(uuidString: id) else { return nil }
        return ResumeScoring(
            matchId: uuid,
            config: MatchConfig(opponent: solo ? nil : opponent, bestOf: bestOf, rated: rated),
            games: games,
            yourSideNumber: yourSideNumber
        )
    }

    /// Context for the correction board — the score-entry flow seeded from the
    /// standing proposal and posting with `supersedes_result_id`. Serves all
    /// three correction verbs the web offers: "Suggest correction" (review),
    /// "Counter" (corrected), and "Edit result" (a self-edit while awaiting).
    /// Nil when there's no standing proposal to correct or the viewer isn't a
    /// participant.
    var correctionContext: ResumeScoring? {
        guard viewerIsParticipant,
              let negotiation,
              let standingId = negotiation.standingResultId,
              negotiation.viewerState.hasStandingProposal,
              let uuid = UUID(uuidString: id) else { return nil }
        return ResumeScoring(
            matchId: uuid,
            config: MatchConfig(opponent: solo ? nil : opponent, bestOf: bestOf, rated: rated),
            games: negotiation.standingGames,
            yourSideNumber: yourSideNumber,
            supersedesResultId: standingId
        )
    }
}

/// Everything the scoring flow needs to resume an existing in-progress match:
/// its server id, the match config (opponent / best-of / rated), the games
/// already entered, and which side the viewer is on. `Identifiable` so it can
/// drive a `.fullScreenCover(item:)` straight into the score-entry screen.
struct ResumeScoring: Identifiable {
    let matchId: UUID
    let config: MatchConfig
    let games: [Game]
    var yourSideNumber: Int = 1
    /// When set, this board is a *correction*: it was seeded from the standing
    /// proposal with this id, and posting supersedes that proposal (a counter,
    /// or a self-edit of the viewer's own posting). Nil for plain live scoring.
    var supersedesResultId: UUID? = nil
    var id: UUID { matchId }

    /// Correction boards tweak the score-entry copy ("Send corrected score").
    var isCorrection: Bool { supersedesResultId != nil }
}

/// A page of the match list plus the per-status counts that drive the filter
/// tab badges. `statusCounts` is keyed by the raw API status string.
struct MatchListPage {
    let items: [FinalMatch]
    let statusCounts: [String: Int]
}

/// Head-to-head summary from the detail BFF, framed from the current user's
/// perspective ("you" vs "them").
struct MatchH2H {
    let youWins: Int
    let themWins: Int
    let meetings: [Meeting]
    var total: Int { youWins + themWins }

    struct Meeting: Identifiable {
        let id = UUID()
        let when: String
        let res: String   // games score, e.g. "3-1"
        let win: Bool
    }
}

/// Games-won tally for the two sides (a = you, b = opponent).
struct SetScore: Hashable {
    var a: Int
    var b: Int
}

/// The two sides of a match. Used both for game winners and for which score
/// field has keyboard focus.
enum MatchSide { case you, opponent }

// MARK: - Match logic (ported from ui.jsx — keep in lockstep with the web client)

enum MatchRules {
    /// 1→1, 3→2, 5→3, 7→4
    static func gamesToWin(bestOf: Int) -> Int { Int(ceil(Double(bestOf) / 2)) }

    /// The reason a completed game's score is illegal under table-tennis rules,
    /// or nil when it's a legal final score. Mirrors `validate_game_score` in
    /// api/app/schemas/match.py (and `illegalScoreReason` in
    /// web-client/src/lib/scoring.ts) — keep in lockstep so the client never
    /// lights up Post for a score the server will reject with a 422.
    static func illegalScoreReason(_ a: Int, _ b: Int) -> String? {
        let winner = max(a, b), loser = min(a, b)
        if winner < 11 { return "The winning side must reach at least 11 points." }
        if a == b { return "A game cannot end in a tie." }
        if winner == 11 && loser > 9 {
            return "At 10–10 the game enters deuce — the winner must lead by 2."
        }
        if winner > 11 {
            if loser < 10 { return "A game can only go past 11 once both sides reach 10." }
            if winner - loser != 2 { return "In a deuce game the winner leads by exactly 2 points." }
        }
        return nil
    }

    /// To 11, win by 2 (deuce continues past 10–10). A game is complete only
    /// when both scores are entered and form a legal final score.
    static func gameComplete(_ g: Game) -> Bool {
        guard let a = g.a, let b = g.b else { return false }
        return illegalScoreReason(a, b) == nil
    }

    /// The winning side, only if the game is complete.
    static func gameWinner(_ g: Game) -> MatchSide? {
        guard gameComplete(g), let a = g.a, let b = g.b else { return nil }
        return a > b ? .you : .opponent
    }

    static func setsWon(_ games: [Game]) -> SetScore {
        var a = 0, b = 0
        for g in games {
            switch gameWinner(g) {
            case .you: a += 1
            case .opponent: b += 1
            case .none: break
            }
        }
        return SetScore(a: a, b: b)
    }

    static func matchDecided(_ games: [Game], bestOf: Int) -> Bool {
        let sw = setsWon(games)
        let need = gamesToWin(bestOf: bestOf)
        return sw.a >= need || sw.b >= need
    }

    /// The canonical postable games: the gap-free run of completed games from
    /// game 1 up to *and including* the game that decides the match, dropping
    /// anything entered past the decider. Returns nil when the games entered so
    /// far don't yet form a complete, decided match — in which case Post must
    /// not be offered.
    ///
    /// Assumes `games` is the dense, position-indexed slot array the score-entry
    /// screen builds (index i ⇒ game i+1, length == bestOf). Contiguity, the
    /// no-duplicate-game-numbers rule, and the bestOf bound that the server's
    /// finalize validator (api/app/matches.py) and the web client's `decidedSide`
    /// (web-client/src/lib/scoring.ts) check explicitly are guaranteed here by
    /// that array shape rather than re-validated: a gap (incomplete slot) before
    /// the decider yields nil, and games past the decider are truncated rather
    /// than rejected (the client simply never posts them).
    static func gamesThroughDecider(_ games: [Game], bestOf: Int) -> [Game]? {
        let need = gamesToWin(bestOf: bestOf)
        var a = 0, b = 0
        for (i, g) in games.enumerated() {
            // A gap (incomplete game) before the match is decided ⇒ not postable.
            guard let winner = gameWinner(g) else { return nil }
            switch winner {
            case .you: a += 1
            case .opponent: b += 1
            }
            if a >= need || b >= need { return Array(games.prefix(i + 1)) }
        }
        return nil
    }

    /// Elo delta, K = 26. Caller passes `won`; returns the signed change.
    static func ratingDelta(won: Bool, yourRating: Int, oppRating: Int) -> Int {
        let expected = 1 / (1 + pow(10, Double(oppRating - yourRating) / 400))
        return Int((26 * ((won ? 1 : 0) - expected)).rounded())
    }
}

// MARK: - Seed data

enum MatchSeed {
    /// Generic stand-in for the signed-in player on the live score-entry
    /// scoreboard (the "you" panel), used only as a fallback before the session
    /// has surfaced a username. Once it has, `ScoreEntryView.meName` carries the
    /// real handle so the entry screen matches the posted result and every
    /// list/detail view (and the web scoreboard) instead of labelling you "You".
    static let me = MatchPlayer(handle: "You", initials: "YOU",
                                avatarColor: .slate, rating: 1500, you: true)
}
