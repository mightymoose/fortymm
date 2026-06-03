import SwiftUI

// MARK: - Player

/// A player in the match flow. `you` marks the signed-in player (orange avatar).
struct MatchPlayer: Identifiable, Hashable {
    var id: String { handle }
    let handle: String
    let initials: String
    var avatarColor: AvatarColor = .slate
    var rating: Int = 1500
    var you: Bool = false

    /// The "Guest" placeholder shown on the opponent side of a solo match.
    static let guest = MatchPlayer(handle: "Guest", initials: "GU", avatarColor: .slate)
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

// MARK: - Seed data (UI-only stub — mirrors chrome.jsx)

enum MatchSeed {
    static let me = MatchPlayer(handle: "gentle-jackdaw", initials: "GJ",
                                avatarColor: .slate, rating: 1847, you: true)

    static let recent: [MatchPlayer] = [
        MatchPlayer(handle: "awesome-sawfish", initials: "AS", avatarColor: .magenta, rating: 1798),
        MatchPlayer(handle: "a3.b-c_d",        initials: "AB", avatarColor: .green,   rating: 1602),
        MatchPlayer(handle: "arboreal-agama",  initials: "AA", avatarColor: .purple,  rating: 1910),
        MatchPlayer(handle: "aromatic-grebe",  initials: "AG", avatarColor: .teal,    rating: 1735),
        MatchPlayer(handle: "bipedal-owl",     initials: "BO", avatarColor: .blue,    rating: 1521),
        MatchPlayer(handle: "blazing-bear",    initials: "BB", avatarColor: .magenta, rating: 2034),
    ]

    static let allPlayers: [MatchPlayer] = recent + [
        MatchPlayer(handle: "crimson-tanager", initials: "CT", avatarColor: .magenta, rating: 1688),
        MatchPlayer(handle: "dapper-marmot",   initials: "DM", avatarColor: .blue,    rating: 1455),
        MatchPlayer(handle: "eager-lynx",      initials: "EL", avatarColor: .teal,    rating: 1972),
        MatchPlayer(handle: "frosty-heron",    initials: "FH", avatarColor: .purple,  rating: 1610),
        MatchPlayer(handle: "gilded-newt",     initials: "GN", avatarColor: .green,   rating: 1843),
        MatchPlayer(handle: "humble-stoat",    initials: "HS", avatarColor: .slate,   rating: 1399),
        MatchPlayer(handle: "ivory-shrike",    initials: "IS", avatarColor: .blue,    rating: 2110),
        MatchPlayer(handle: "jovial-quokka",   initials: "JQ", avatarColor: .magenta, rating: 1564),
        MatchPlayer(handle: "keen-osprey",     initials: "KO", avatarColor: .teal,    rating: 1726),
        MatchPlayer(handle: "lucky-vole",      initials: "LV", avatarColor: .green,   rating: 1487),
        MatchPlayer(handle: "mellow-earthworm",initials: "ME", avatarColor: .purple,  rating: 1662),
        MatchPlayer(handle: "nimble-gecko",    initials: "NG", avatarColor: .blue,    rating: 1901),
    ]

    /// Seed match history for the Matches list, normalized into `FinalMatch`.
    static let matches: [FinalMatch] = [
        make("7C1A04", "awesome-sawfish", "AS", .magenta, true,  [[11,7],[11,9],[9,11],[11,6]], "Yesterday", "Club ladder", true, 14),
        make("4F9B22", "a3.b-c_d",        "AB", .green,   true,  [[11,8],[8,11],[11,9],[6,11],[11,7]], "Yesterday", "Club ladder", true, 18),
        make("2D7E51", "blazing-bear",    "BB", .magenta, false, [[7,11],[11,9],[6,11],[8,11]], "Sat Apr 12", "Friendly", false, -9),
        make("9A3C18", "arboreal-agama",  "AA", .purple,  true,  [[11,5],[9,11],[11,7],[11,8]], "Fri Apr 11", "Club ladder", true, 11),
        make("5B8F73", "bipedal-owl",     "BO", .blue,    true,  [[11,9],[11,7],[8,11],[11,6]], "Thu Apr 10", "Friendly", false, 8),
        make("1E6D40", "aromatic-grebe",  "AG", .teal,    false, [[11,8],[9,11],[11,7],[7,11],[9,11]], "Tue Apr 8", "Club ladder", true, -6),
    ]

    private static func make(_ id: String, _ opp: String, _ oppInit: String, _ color: AvatarColor,
                             _ win: Bool, _ scores: [[Int]], _ when: String, _ ctx: String,
                             _ rated: Bool, _ delta: Int) -> FinalMatch {
        let games = scores.map { Game(a: $0[0], b: $0[1]) }
        let sw = MatchRules.setsWon(games)
        let rating = recent.first { $0.handle == opp }?.rating ?? 1700
        let bestOf = max(sw.a, sw.b) * 2 - 1
        return FinalMatch(
            id: id,
            you: me,
            opponent: MatchPlayer(handle: opp, initials: oppInit, avatarColor: color, rating: rating),
            solo: false, games: games, bestOf: bestOf, rated: rated,
            setsWon: sw, win: win, ratingDelta: rated ? delta : nil,
            when: when, context: ctx
        )
    }
}

// MARK: - Season record

struct SeasonRecord {
    var wins: Int = 42
    var losses: Int = 18
    var streak: String = "4W"
    var logged: Int = 128

    var total: Int { wins + losses }
    var winRate: Int { total == 0 ? 0 : Int((Double(wins) / Double(total) * 100).rounded()) }

    /// Streak string like "4W" / "2L", extended or reset by a new result.
    mutating func record(win: Bool) {
        wins += win ? 1 : 0
        losses += win ? 0 : 1
        logged += 1
        let scanner = Scanner(string: streak)
        let n = scanner.scanInt() ?? 0
        let last = scanner.scanCharacter().map(String.init) ?? "W"
        let cur = win ? "W" : "L"
        streak = "\(cur == last ? n + 1 : 1)\(cur)"
    }
}
