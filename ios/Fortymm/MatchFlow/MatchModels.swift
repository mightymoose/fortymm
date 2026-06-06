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
    /// User-facing status, e.g. "Final" / "Awaiting confirmation" / "Live".
    var statusLabel: String = "Final"
    /// True once the result is official (match completed). When false, the
    /// posted result is still awaiting the opponent's confirmation, so the
    /// W/L celebration and rating change are not yet real.
    var decided: Bool = true
    /// True when a result has been posted but the match isn't decided yet — i.e.
    /// it's genuinely awaiting a sign-off. Distinct from `!decided`, which is
    /// also true for a freshly-created *live* match that has no posted result.
    var awaitingConfirmation: Bool = false
    /// The current user owes a confirm/dispute on this posted result.
    var canConfirm: Bool = false
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
    /// no posted result currently awaiting confirmation. Drives the "resume
    /// scoring" affordances on the detail, list, and dashboard surfaces.
    var canScore: Bool = false
    /// The saved games already form a decided, valid match and the viewer can
    /// post the result. True for a match scored to a decision but never posted
    /// (e.g. a web user entered the games then left) — which `canScore` is
    /// *false* for, since there's no next game to enter. Drives the detail
    /// screen's "Post result" recovery path.
    var canFinalize: Bool = false
    /// The viewer's side number (1 or 2). Used to orient entered scores back to
    /// the canonical side-1/side-2 axis when resuming a match the viewer didn't
    /// create. Defaults to side 1 (the match creator).
    var yourSideNumber: Int = 1

    /// The viewer can resume entering scores: a participant on a live match with
    /// no posted result awaiting confirmation. Single source of truth for the
    /// "Score" affordances on the list, detail, and dashboard surfaces.
    var canResume: Bool { canScore && inProgress && !awaitingConfirmation }

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
    var id: UUID { matchId }
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

    /// To 11, win by 2 (deuce continues past 10–10).
    static func gameComplete(_ g: Game) -> Bool {
        guard let a = g.a, let b = g.b else { return false }
        let hi = max(a, b), lo = min(a, b)
        return a != b && hi >= 11 && (hi - lo) >= 2
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

    /// Elo delta, K = 26. Caller passes `won`; returns the signed change.
    static func ratingDelta(won: Bool, yourRating: Int, oppRating: Int) -> Int {
        let expected = 1 / (1 + pow(10, Double(oppRating - yourRating) / 400))
        return Int((26 * ((won ? 1 : 0) - expected)).rounded())
    }
}

// MARK: - Seed data

enum MatchSeed {
    /// Stand-in for the signed-in player, used only on the live score-entry
    /// scoreboard (the "you" panel) while a game is in progress. The session
    /// doesn't surface the user's id/handle app-wide, so the entry screen
    /// labels your side generically; the *posted* result and every list/detail
    /// view render the real username from the API response.
    static let me = MatchPlayer(handle: "You", initials: "YOU",
                                avatarColor: .slate, rating: 1500, you: true)
}
