import CryptoKit
import Foundation
import Testing
@testable import FortyMM

/// The client checks of api/signed-results/README.md, against every vector.
/// The app doesn't verify (V8, I1), because only the server holds the key
/// directory.
struct SignedResultVectorTests {
    static let vectors = Vectors.shared

    @Test func theVectorsLoad() throws {
        let vectors = try Vectors.load()
        #expect(vectors.format == "fortymm/match-result/v1")
        #expect(!vectors.keys.isEmpty)
        #expect(!vectors.valid.isEmpty)
        #expect(!vectors.invalid.isEmpty)
        #expect(!vectors.registrations.isEmpty)
    }

    @Test("K1 to K3", arguments: vectors.namedKeys)
    func key(_ named: Vectors.Named<Vectors.Key>) throws {
        let key = named.value
        let derived = try key.privateKey.publicKey
        #expect(derived.rawRepresentation == key.x.data + key.y.data)

        let publicKey = SigningPublicKey(try key.publicKey)
        #expect(publicKey.coseKey == key.coseKey.data)
        #expect(publicKey.kid.bytes == key.kid.data)
    }

    @Test("V1 and V2", arguments: vectors.valid)
    func payload(_ vector: Vectors.Valid) throws {
        let result = try vector.result.matchResult
        let issuedAt = try #require(IssuedAt(seconds: vector.issuedAt))

        #expect(Payload.encode(result, issuedAt: issuedAt) == vector.payload.data)

        let (decoded, decodedAt) = try Payload.decode(vector.payload.data)
        #expect(decoded == result)
        #expect(decodedAt == issuedAt)
        #expect(ResultHash(of: vector.payload.data).bytes == vector.hash.data)
    }

    @Test("V3 and V4", arguments: vectors.valid)
    func signatures(_ vector: Vectors.Valid) throws {
        for signature in vector.signatures {
            let kid = try #require(KeyId(signature.kid.data))
            let side = try #require(Side(rawValue: signature.side))
            #expect(ResultSignature.protectedHeader(kid: kid, side: side) == signature.protected.data)
            #expect(
                SignedResult.toBeSigned(protected: signature.protected.data, payload: vector.payload.data)
                    == signature.toBeSigned.data
            )

            let key = try Self.vectors.key(signature.key)
            let publicKey = try key.publicKey
            #expect(try verifies(signature.signature.data, over: signature.toBeSigned.data, with: publicKey))
            let ours = try SigningKey(software: key.privateKey).sign(signature.toBeSigned.data)
            #expect(ours.count == 64)
            #expect(try verifies(ours, over: signature.toBeSigned.data, with: publicKey))
        }
    }

    @Test("V5", arguments: vectors.valid)
    func envelope(_ vector: Vectors.Valid) throws {
        let signatures = try vector.signatures.map {
            try ResultSignature(protected: $0.protected.data, signature: $0.signature.data)
        }
        let assembled = try SignedResult(payload: vector.payload.data, signatures: signatures)
        #expect(assembled.bytes == vector.envelope.data)

        guard signatures.count >= 2 else { return }
        let others = try SignedResult(payload: vector.payload.data, signatures: Array(signatures.dropLast()))
        #expect(others.appending(signatures.last!).bytes == vector.envelope.data)
    }

    @Test("V6, V7 and reading every valid envelope", arguments: vectors.valid)
    func text(_ vector: Vectors.Valid) throws {
        let signed = try SignedResult(bytes: vector.envelope.data)
        #expect(signed.bytes == vector.envelope.data)
        #expect(signed.result == (try vector.result.matchResult))
        #expect(signed.issuedAt.seconds == vector.issuedAt)
        #expect(signed.hash.bytes == vector.hash.data)
        #expect(signed.signatures.map(\.kid.bytes) == vector.signatures.map(\.kid.data))
        #expect(signed.signatures.map(\.side.rawValue) == vector.signatures.map(\.side))

        #expect(signed.qrText == vector.qr)
        #expect(signed.link == vector.link)
        #expect(try SignedResult(text: vector.qr).bytes == vector.envelope.data)
        #expect(try SignedResult(text: vector.link).bytes == vector.envelope.data)

        let alphanumeric = Set("0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:")
        #expect(vector.qr.allSatisfy(alphanumeric.contains))
        // QR version 16 at level M holds 656 alphanumeric characters.
        if vector.signatures.count <= 2 { #expect(vector.qr.count <= 656) }
    }

    @Test("I2", arguments: vectors.invalid)
    func invalid(_ vector: Vectors.Invalid) throws {
        let read = { () throws(Malformed) -> SignedResult in
            if let text = vector.text { return try SignedResult(text: text) }
            return try SignedResult(bytes: vector.envelope!.data)
        }
        if vector.error == "malformed" {
            #expect(throws: Malformed.self) { try read() }
        } else {
            #expect(throws: Never.self) { try read() }
        }
    }

    @Test("R1 and R2", arguments: vectors.registrations)
    func registration(_ vector: Vectors.Registration) throws {
        let key = try Self.vectors.key(vector.key)
        let kid = try #require(KeyId(key.kid.data))
        #expect(RegistrationProof.protectedHeader(kid: kid) == vector.protected.data)
        #expect(RegistrationProof.payload(account: vector.account) == vector.payload.data)
        #expect(
            RegistrationProof.toBeSigned(protected: vector.protected.data, payload: vector.payload.data)
                == vector.toBeSigned.data
        )

        #expect(try verifies(vector.signature.data, over: vector.toBeSigned.data, with: key.publicKey))
        let proof = try RegistrationProof.make(key: SigningKey(software: key.privateKey), account: vector.account)
        #expect(proof.count == 160)
        #expect(proof.prefix(96) == vector.proof.data.prefix(96))
        #expect(try verifies(Data(proof.suffix(64)), over: vector.toBeSigned.data, with: key.publicKey))
    }

    @Test func signsAndCountersignsAResult() throws {
        let ann = try SigningKey(software: Self.vectors.key("ann").privateKey)
        let bo = try SigningKey(software: Self.vectors.key("bo").privateKey)
        let vector = try #require(Self.vectors.valid.first { $0.name == "completed-best-of-3" })
        let issuedAt = try #require(IssuedAt(seconds: vector.issuedAt))

        let half = try SignedResult.sign(vector.result.matchResult, issuedAt: issuedAt, key: ann, side: .first)
        let full = try SignedResult(text: half.qrText).countersigned(by: bo, side: .second)

        #expect(full.payload == vector.payload.data)
        #expect(full.signatures.map(\.protected) == vector.signatures.map(\.protected.data))
        for (signature, expected) in zip(full.signatures, vector.signatures) {
            let key = try Self.vectors.key(expected.key).publicKey
            #expect(try verifies(signature.signature, over: expected.toBeSigned.data, with: key))
        }
        #expect(try SignedResult(bytes: full.bytes) == full)
    }

    @Test func aResultRefusesWhatTheFormatForbids() throws {
        let one = UUID()
        #expect(Players(one, one) == nil)
        let players = try #require(Players(one, UUID()))
        let games = Array(repeating: Game(first: 11, second: 0), count: 4)
        #expect(MatchResult(match: UUID(), bestOf: .three, rated: true, players: players, games: games, ending: .completed) == nil)
        #expect(IssuedAt(seconds: IssuedAt.max + 1) == nil)
    }

    private func verifies(_ signature: Data, over message: Data, with key: P256.Signing.PublicKey) throws -> Bool {
        key.isValidSignature(try P256.Signing.ECDSASignature(rawRepresentation: signature), for: message)
    }
}
