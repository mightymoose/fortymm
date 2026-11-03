import CryptoKit
import Foundation
import Testing
@testable import FortyMM

/// api/signed-results/vectors.json, which the test bundle carries. Its
/// README says what each field holds.
struct Vectors: Decodable, Sendable {
    struct Key: Decodable, Sendable {
        let d: Hex
        let x: Hex
        let y: Hex
        let coseKey: Hex
        let kid: Hex

        var privateKey: P256.Signing.PrivateKey {
            get throws { try P256.Signing.PrivateKey(rawRepresentation: d.data) }
        }

        var publicKey: P256.Signing.PublicKey {
            get throws { try P256.Signing.PublicKey(rawRepresentation: x.data + y.data) }
        }
    }

    struct Result: Decodable, Sendable {
        let match: UUID
        let bestOf: UInt64
        let rated: Bool
        let players: [UUID]
        let games: [[UInt]]
        let ending: String
        let retiredBy: UInt64?
        let replaces: Hex?

        var matchResult: MatchResult {
            get throws {
                let ending: Ending = switch ending {
                case "completed": .completed
                default: .retired(by: try #require(retiredBy.flatMap(Side.init(rawValue:))))
                }
                let format = try #require(BestOf(rawValue: bestOf))
                let pair = try #require(Players(players[0], players[1]))
                let hash = replaces.flatMap { ResultHash($0.data) }
                #expect((hash == nil) == (replaces == nil))
                let result = MatchResult(
                    match: match,
                    bestOf: format,
                    rated: rated,
                    players: pair,
                    games: games.map { Game(first: $0[0], second: $0[1]) },
                    ending: ending,
                    replaces: hash
                )
                return try #require(result)
            }
        }
    }

    struct Signature: Decodable, Sendable {
        let key: String
        let kid: Hex
        let side: UInt64
        let protected: Hex
        let toBeSigned: Hex
        let signature: Hex
    }

    struct Valid: Decodable, Sendable, CustomTestStringConvertible {
        let name: String
        let issuedAt: UInt64
        let result: Result
        let payload: Hex
        let hash: Hex
        let signatures: [Signature]
        let envelope: Hex
        let qr: String
        let link: String

        var testDescription: String { name }
    }

    struct Invalid: Decodable, Sendable, CustomTestStringConvertible {
        let name: String
        let error: String
        let envelope: Hex?
        let text: String?

        var testDescription: String { name }
    }

    struct Registration: Decodable, Sendable, CustomTestStringConvertible {
        let name: String
        let key: String
        let account: UUID
        let protected: Hex
        let payload: Hex
        let toBeSigned: Hex
        let signature: Hex
        let proof: Hex

        var testDescription: String { name }
    }

    struct Named<Value: Sendable>: Sendable, CustomTestStringConvertible {
        let name: String
        let value: Value
        var testDescription: String { name }
    }

    let format: String
    let keys: [String: Key]
    let valid: [Valid]
    let invalid: [Invalid]
    let registrations: [Registration]

    var namedKeys: [Named<Key>] {
        keys.sorted { $0.key < $1.key }.map { Named(name: $0.key, value: $0.value) }
    }

    func key(_ name: String) throws -> Key {
        try #require(keys[name], "no key \(name)")
    }

    static func load() throws -> Vectors {
        let url = try #require(Bundle(for: BundleToken.self).url(forResource: "vectors", withExtension: "json"))
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        return try decoder.decode(Vectors.self, from: Data(contentsOf: url))
    }

    /// Empty if the file doesn't load, which `theVectorsLoad` reports, so a
    /// parameterized test has its arguments without a crash.
    static let shared = (try? load()) ?? Vectors(format: "", keys: [:], valid: [], invalid: [], registrations: [])
}

private final class BundleToken {}

/// Bytes that the vectors write as lowercase hex.
struct Hex: Decodable, Sendable {
    let data: Data

    init(from decoder: Decoder) throws {
        let text = try decoder.singleValueContainer().decode(String.self)
        guard let data = Data(hex: text) else {
            throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "not hex"))
        }
        self.data = data
    }
}

extension Data {
    init?(hex: String) {
        guard hex.count.isMultiple(of: 2) else { return nil }
        var data = Data()
        var index = hex.startIndex
        while index < hex.endIndex {
            let next = hex.index(index, offsetBy: 2)
            guard let byte = UInt8(hex[index..<next], radix: 16) else { return nil }
            data.append(byte)
            index = next
        }
        self = data
    }
}
