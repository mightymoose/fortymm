import CryptoKit
import Foundation

/// A match result, as api/signed-results/README.md ("The payload") gives
/// it. A value always has two distinct players, at most `bestOf` games and
/// a `replaces` of 32 bytes, so it always encodes to a valid payload.
struct MatchResult: Equatable, Sendable {
    enum BestOf: UInt64, Sendable {
        case three = 3
        case five = 5
        case seven = 7
    }

    /// An index into `players`.
    enum Side: UInt64, Sendable {
        case first = 0
        case second = 1
    }

    enum Ending: Equatable, Sendable {
        case completed
        case retired(by: Side)
    }

    /// One game's points, for `players.0` then `players.1`.
    struct Game: Equatable, Sendable {
        let first: UInt64
        let second: UInt64
    }

    let match: UUID
    let bestOf: BestOf
    let rated: Bool
    let players: (UUID, UUID)
    let games: [Game]
    let ending: Ending
    /// For a correction, the hash of the result it replaces.
    let replaces: Data?

    init(
        match: UUID,
        bestOf: BestOf,
        rated: Bool,
        players: (UUID, UUID),
        games: [Game],
        ending: Ending,
        replaces: Data? = nil
    ) throws(Malformed) {
        guard players.0 != players.1,
              games.count <= Int(bestOf.rawValue),
              replaces.map({ $0.count == SHA256.byteCount }) ?? true
        else { throw Malformed() }
        self.match = match
        self.bestOf = bestOf
        self.rated = rated
        self.players = players
        self.games = games
        self.ending = ending
        self.replaces = replaces
    }

    static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.match == rhs.match && lhs.bestOf == rhs.bestOf && lhs.rated == rhs.rated
            && lhs.players == rhs.players && lhs.games == rhs.games && lhs.ending == rhs.ending
            && lhs.replaces == rhs.replaces
    }
}

/// A CWT claims set of `iat` and one match result. `bytes` are what the
/// players sign, and their SHA-256 is the result's identity.
struct ResultPayload: Equatable, Sendable {
    /// 9999-12-31T23:59:59Z, the latest `iat` the format allows.
    static let latestIssuedAt: UInt64 = 253_402_300_799
    static let domainTag = "fortymm/match-result/v1"

    let issuedAt: UInt64
    let result: MatchResult
    let bytes: Data

    init(issuedAt: UInt64, result: MatchResult) throws(Malformed) {
        guard issuedAt <= Self.latestIssuedAt else { throw Malformed() }
        self.issuedAt = issuedAt
        self.result = result
        bytes = CBOR.map([
            .init(key: .unsigned(Key.issuedAt), value: .unsigned(issuedAt)),
            .init(key: .text(Self.domainTag), value: result.cbor),
        ]).encoded
    }

    /// Reads payload bytes. Anything but a payload this type would write
    /// byte for byte is `Malformed`.
    init(bytes: Data) throws(Malformed) {
        let claims = try Fields(CBOR(deterministic: bytes), keys: [.unsigned(Key.issuedAt), .text(Self.domainTag)])
        try self.init(
            issuedAt: try claims.unsigned(.unsigned(Key.issuedAt)),
            result: try MatchResult(cbor: claims.required(.text(Self.domainTag)))
        )
        guard self.bytes == bytes else { throw Malformed() }
    }

    var hash: Data { Data(SHA256.hash(data: bytes)) }

    private enum Key {
        static let issuedAt: UInt64 = 6
    }
}

private enum ResultKey: UInt64, CaseIterable {
    case match = 1, bestOf, rated, players, games, ending, retiredBy, replaces

    var cbor: CBOR { .unsigned(rawValue) }
}

private extension MatchResult {
    var cbor: CBOR {
        var entries: [CBOR.Entry] = [
            .init(key: ResultKey.match.cbor, value: .bytes(match.data)),
            .init(key: ResultKey.bestOf.cbor, value: .unsigned(bestOf.rawValue)),
            .init(key: ResultKey.rated.cbor, value: .bool(rated)),
            .init(key: ResultKey.players.cbor, value: .array([.bytes(players.0.data), .bytes(players.1.data)])),
            .init(key: ResultKey.games.cbor, value: .array(games.map { .array([.unsigned($0.first), .unsigned($0.second)]) })),
        ]
        switch ending {
        case .completed:
            entries.append(.init(key: ResultKey.ending.cbor, value: .unsigned(0)))
        case .retired(let side):
            entries.append(.init(key: ResultKey.ending.cbor, value: .unsigned(1)))
            entries.append(.init(key: ResultKey.retiredBy.cbor, value: .unsigned(side.rawValue)))
        }
        if let replaces {
            entries.append(.init(key: ResultKey.replaces.cbor, value: .bytes(replaces)))
        }
        return .map(entries)
    }

    init(cbor: CBOR) throws(Malformed) {
        let fields = try Fields(cbor, keys: ResultKey.allCases.map(\.cbor))
        guard let bestOf = BestOf(rawValue: try fields.unsigned(ResultKey.bestOf.cbor)),
              case .bool(let rated) = try fields.required(ResultKey.rated.cbor),
              case .array(let players) = try fields.required(ResultKey.players.cbor), players.count == 2,
              case .array(let games) = try fields.required(ResultKey.games.cbor)
        else { throw Malformed() }

        let ending: Ending
        switch (try fields.unsigned(ResultKey.ending.cbor), fields[ResultKey.retiredBy.cbor]) {
        case (0, nil):
            ending = .completed
        case (1, .unsigned(let side)?):
            guard let side = Side(rawValue: side) else { throw Malformed() }
            ending = .retired(by: side)
        default:
            throw Malformed()
        }

        var points: [Game] = []
        for game in games {
            guard case .array(let pair) = game, pair.count == 2,
                  case .unsigned(let first) = pair[0], case .unsigned(let second) = pair[1]
            else { throw Malformed() }
            points.append(Game(first: first, second: second))
        }

        var replaces: Data?
        if let value = fields[ResultKey.replaces.cbor] {
            guard case .bytes(let hash) = value else { throw Malformed() }
            replaces = hash
        }

        try self.init(
            match: try UUID(cbor: fields.required(ResultKey.match.cbor)),
            bestOf: bestOf,
            rated: rated,
            players: (try UUID(cbor: players[0]), try UUID(cbor: players[1])),
            games: points,
            ending: ending,
            replaces: replaces
        )
    }
}

/// A CBOR map read by key, holding no key but `keys`.
struct Fields {
    private let entries: [CBOR.Entry]

    init(_ item: CBOR, keys: [CBOR]) throws(Malformed) {
        guard case .map(let entries) = item, entries.allSatisfy({ keys.contains($0.key) }) else { throw Malformed() }
        self.entries = entries
    }

    subscript(key: CBOR) -> CBOR? {
        entries.first { $0.key == key }?.value
    }

    func required(_ key: CBOR) throws(Malformed) -> CBOR {
        guard let value = self[key] else { throw Malformed() }
        return value
    }

    func unsigned(_ key: CBOR) throws(Malformed) -> UInt64 {
        guard case .unsigned(let value) = try required(key) else { throw Malformed() }
        return value
    }

    func bytes(_ key: CBOR, count: Int) throws(Malformed) -> Data {
        guard case .bytes(let value) = try required(key), value.count == count else { throw Malformed() }
        return value
    }
}

extension UUID {
    /// The UUID's 16 bytes, as the format writes every id.
    var data: Data { withUnsafeBytes(of: uuid) { Data($0) } }

    init(data: Data) throws(Malformed) {
        guard data.count == 16 else { throw Malformed() }
        var bytes = uuid_t(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0)
        withUnsafeMutableBytes(of: &bytes) { $0.copyBytes(from: data) }
        self.init(uuid: bytes)
    }

    fileprivate init(cbor: CBOR) throws(Malformed) {
        guard case .bytes(let data) = cbor else { throw Malformed() }
        try self.init(data: data)
    }
}
