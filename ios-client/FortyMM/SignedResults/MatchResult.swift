import CryptoKit
import Foundation

enum BestOf: UInt64, Sendable {
    case three = 3
    case five = 5
    case seven = 7
}

/// An index into a result's players.
enum Side: UInt64, Sendable {
    case first = 0
    case second = 1
}

/// The two players of a match. Distinct, and their order fixes the order of
/// each game's points.
struct Players: Equatable, Sendable {
    let first: UUID
    let second: UUID

    init?(_ first: UUID, _ second: UUID) {
        guard first != second else { return nil }
        self.first = first
        self.second = second
    }

    subscript(side: Side) -> UUID {
        switch side {
        case .first: first
        case .second: second
        }
    }
}

/// One game's points, for players.first then players.second.
struct Game: Equatable, Sendable {
    let first: UInt
    let second: UInt
}

enum Ending: Equatable, Sendable {
    case completed
    case retired(by: Side)
}

/// The SHA-256 of a payload's bytes, the result's identity.
struct ResultHash: Hashable, Sendable {
    let bytes: Data

    init?(_ bytes: Data) {
        guard bytes.count == SHA256.byteCount else { return nil }
        self.bytes = bytes
    }

    init(of payload: Data) {
        bytes = Data(SHA256.hash(data: payload))
    }
}

/// Seconds since the Unix epoch, up to 9999-12-31T23:59:59Z.
struct IssuedAt: Equatable, Sendable {
    static let max: UInt64 = 253_402_300_799

    let seconds: UInt64

    init?(seconds: UInt64) {
        guard seconds <= Self.max else { return nil }
        self.seconds = seconds
    }
}

/// What a signed result says happened in a match. The format fixes only its
/// shape and types. Whether the scores are a legal ending is the server's
/// rule.
struct MatchResult: Equatable, Sendable {
    let match: UUID
    let bestOf: BestOf
    let rated: Bool
    let players: Players
    /// In the order played. A retirement can come before a game ends, so the
    /// last game may be unfinished.
    let games: [Game]
    let ending: Ending
    /// For a correction, the hash of the result it replaces.
    let replaces: ResultHash?

    /// Nil if there are more games than `bestOf`.
    init?(match: UUID, bestOf: BestOf, rated: Bool, players: Players, games: [Game], ending: Ending, replaces: ResultHash? = nil) {
        guard games.count <= bestOf.rawValue else { return nil }
        self.match = match
        self.bestOf = bestOf
        self.rated = rated
        self.players = players
        self.games = games
        self.ending = ending
        self.replaces = replaces
    }
}

/// The payload: the CWT claims map `{6: iat, "fortymm/match-result/v1":
/// result}`. Its bytes are what every signer signs.
enum Payload {
    static let domainTag = CBOR.text("fortymm/match-result/v1")
    private static let iat = CBOR.unsigned(6)
    private static let match = CBOR.unsigned(1)
    private static let bestOf = CBOR.unsigned(2)
    private static let rated = CBOR.unsigned(3)
    private static let players = CBOR.unsigned(4)
    private static let games = CBOR.unsigned(5)
    private static let ending = CBOR.unsigned(6)
    private static let retiredBy = CBOR.unsigned(7)
    private static let replaces = CBOR.unsigned(8)

    static func encode(_ result: MatchResult, issuedAt: IssuedAt) -> Data {
        var map: [CBOR: CBOR] = [
            match: .bytes(result.match.bytes),
            bestOf: .unsigned(result.bestOf.rawValue),
            rated: .bool(result.rated),
            players: .array([.bytes(result.players.first.bytes), .bytes(result.players.second.bytes)]),
            games: .array(result.games.map { .array([.unsigned(UInt64($0.first)), .unsigned(UInt64($0.second))]) }),
        ]
        switch result.ending {
        case .completed:
            map[ending] = .unsigned(0)
        case .retired(let side):
            map[ending] = .unsigned(1)
            map[retiredBy] = .unsigned(side.rawValue)
        }
        if let hash = result.replaces { map[replaces] = .bytes(hash.bytes) }
        return CBOR.map([iat: .unsigned(issuedAt.seconds), domainTag: .map(map)]).encoded
    }

    static func decode(_ payload: Data) throws(Malformed) -> (MatchResult, IssuedAt) {
        let claims = try CBOR.decode(payload).map(required: [iat, domainTag])
        guard let issuedAt = IssuedAt(seconds: try claims[iat]!.uint()) else {
            throw Malformed("iat is after 9999-12-31T23:59:59Z")
        }
        let r = try claims[domainTag]!.map(
            required: [match, bestOf, rated, players, games, ending],
            optional: [retiredBy, replaces]
        )
        let end: Ending
        switch (try r[ending]!.uint(), r[retiredBy]) {
        case (0, nil): end = .completed
        case (1, let side?): end = .retired(by: try Self.side(side))
        default: throw Malformed("ending isn't 0 without retired_by or 1 with it")
        }
        guard let format = BestOf(rawValue: try r[bestOf]!.uint()) else { throw Malformed("best_of isn't 3, 5 or 7") }
        let pair = try r[players]!.array(count: 2)
        guard let players = Players(try uuid(pair[0]), try uuid(pair[1])) else {
            throw Malformed("the players are the same player")
        }
        var points: [Game] = []
        for game in try r[games]!.array() {
            let both = try game.array(count: 2)
            points.append(Game(first: UInt(try both[0].uint()), second: UInt(try both[1].uint())))
        }
        let hash = try r[replaces].map { item throws(Malformed) in ResultHash(try item.bytes(count: SHA256.byteCount))! }
        guard let result = MatchResult(
            match: try uuid(r[match]!),
            bestOf: format,
            rated: try r[rated]!.bool(),
            players: players,
            games: points,
            ending: end,
            replaces: hash
        ) else { throw Malformed("more games than best_of") }
        return (result, issuedAt)
    }

    static func side(_ item: CBOR) throws(Malformed) -> Side {
        guard let side = Side(rawValue: try item.uint()) else { throw Malformed("a side isn't 0 or 1") }
        return side
    }

    private static func uuid(_ item: CBOR) throws(Malformed) -> UUID {
        UUID(bytes: try item.bytes(count: 16))
    }
}

extension UUID {
    /// The 16 bytes, as the format carries a UUID.
    var bytes: Data {
        withUnsafeBytes(of: uuid) { Data($0) }
    }

    /// `bytes` must hold 16 bytes.
    init(bytes: Data) {
        precondition(bytes.count == 16)
        self.init(uuid: bytes.withUnsafeBytes { $0.loadUnaligned(as: uuid_t.self) })
    }
}
