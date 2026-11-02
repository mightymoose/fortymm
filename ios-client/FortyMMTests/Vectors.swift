import CryptoKit
import Foundation
import Testing
@testable import FortyMM

/// `api/signed-results/vectors.json`, which the test bundle copies, in the
/// fields this suite checks. api/signed-results/README.md ("Test vectors")
/// says what each field means.
struct Vectors: Decodable {
    struct Key: Decodable {
        let d: Hex
        let x: Hex
        let y: Hex
        let coseKey: Hex
        let kid: Hex
    }

    struct Result: Decodable {
        let match: UUID
        let bestOf: UInt64
        let rated: Bool
        let players: [UUID]
        let games: [[UInt64]]
        let ending: String
        let retiredBy: UInt64?
        let replaces: Hex?
    }

    struct Signature: Decodable {
        let key: String
        let kid: Hex
        let side: UInt64
        let `protected`: Hex
        let toBeSigned: Hex
        let signature: Hex
    }

    struct Valid: Decodable {
        let name: String
        let issuedAt: UInt64
        let result: Result
        let payload: Hex
        let hash: Hex
        let signatures: [Signature]
        let envelope: Hex
        let qr: String
        let link: String
    }

    struct Invalid: Decodable {
        let name: String
        let error: String
        let envelope: Hex?
        let text: String?
    }

    struct Registration: Decodable {
        let name: String
        let key: String
        let account: UUID
        let `protected`: Hex
        let payload: Hex
        let toBeSigned: Hex
        let signature: Hex
        let proof: Hex
    }

    let format: String
    let keys: [String: Key]
    let valid: [Valid]
    let invalid: [Invalid]
    let registrations: [Registration]

    static let shared: Vectors = {
        let url = Bundle(for: BundleToken.self).url(forResource: "vectors", withExtension: "json")!
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        return try! decoder.decode(Vectors.self, from: Data(contentsOf: url))
    }()

    private final class BundleToken {}
}

/// Lowercase hex, as the vectors write bytes.
struct Hex: Decodable, Equatable, CustomStringConvertible {
    let data: Data

    init(from decoder: Decoder) throws {
        let text = try decoder.singleValueContainer().decode(String.self)
        var data = Data()
        var index = text.startIndex
        while index < text.endIndex {
            let next = text.index(index, offsetBy: 2)
            guard let byte = UInt8(text[index..<next], radix: 16) else {
                throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "not hex"))
            }
            data.append(byte)
            index = next
        }
        self.data = data
    }

    var description: String { data.hex }
}

extension Vectors.Result {
    var matchResult: MatchResult {
        get throws {
            let side = retiredBy.flatMap(MatchResult.Side.init(rawValue:))
            return try MatchResult(
                match: match,
                bestOf: #require(MatchResult.BestOf(rawValue: bestOf)),
                rated: rated,
                players: (players[0], players[1]),
                games: games.map { MatchResult.Game(first: $0[0], second: $0[1]) },
                ending: ending == "retired" ? .retired(by: #require(side)) : .completed,
                replaces: replaces?.data
            )
        }
    }
}

/// A software key from a vector's private scalar, which signs through
/// CryptoKit, as the app's keys do.
struct TestKey: MessageSigner {
    let key: P256.Signing.PrivateKey

    static func named(_ name: String) throws -> TestKey {
        TestKey(key: try P256.Signing.PrivateKey(rawRepresentation: Vectors.shared.keys[name]!.d.data))
    }

    var publicKey: SigningPublicKey { SigningPublicKey(key: key.publicKey) }

    func sign(_ message: Data) throws -> Data {
        try key.signature(for: message).rawRepresentation
    }
}
