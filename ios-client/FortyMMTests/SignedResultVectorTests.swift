import CryptoKit
import Foundation
import Testing
@testable import FortyMM

/// The signer checks of api/signed-results/README.md ("Checks a client's
/// suite runs"), against the shared vectors. Each test's name starts with
/// the check's id.
struct SignedResultVectorTests {
    static let vectors = Vectors.shared
    static let keyNames = vectors.keys.keys.sorted()
    static let validNames = vectors.valid.map(\.name)
    static let invalidNames = vectors.invalid.map(\.name)
    static let registrationNames = vectors.registrations.map(\.name)

    static func valid(_ name: String) -> Vectors.Valid { vectors.valid.first { $0.name == name }! }

    @Test func theVectorsAreThisFormat() {
        #expect(Self.vectors.format == ResultPayload.domainTag)
        #expect(!Self.vectors.valid.isEmpty && !Self.vectors.invalid.isEmpty && !Self.vectors.registrations.isEmpty)
    }

    @Test(arguments: keyNames)
    func k1To3TheKeyEncodesAsTheVectorSays(name: String) throws {
        let vector = try #require(Self.vectors.keys[name])
        let key = try TestKey.named(name).publicKey

        #expect(key.x == vector.x.data)
        #expect(key.y == vector.y.data)
        #expect(key.coseKey == vector.coseKey.data)
        #expect(key.kid.bytes == vector.kid.data)
    }

    @Test(arguments: validNames)
    func v1EncodingTheResultGivesThePayload(name: String) throws {
        let vector = Self.valid(name)

        let payload = try ResultPayload(issuedAt: vector.issuedAt, result: vector.result.matchResult)

        #expect(payload.bytes == vector.payload.data)
    }

    @Test(arguments: validNames)
    func v2DecodingThePayloadGivesTheResult(name: String) throws {
        let vector = Self.valid(name)

        let payload = try ResultPayload(bytes: vector.payload.data)

        #expect(payload.issuedAt == vector.issuedAt)
        #expect(payload.result == (try vector.result.matchResult))
        #expect(payload.hash == vector.hash.data)
    }

    @Test(arguments: validNames)
    func v3TheHeadersAndSigStructuresMatch(name: String) throws {
        let vector = Self.valid(name)

        for signature in vector.signatures {
            let side = try #require(MatchResult.Side(rawValue: signature.side))
            let protected = ResultSignature.protected(kid: try KeyID(bytes: signature.kid.data), side: side)
            #expect(protected == signature.protected.data)
            #expect(ResultSignature.toBeSigned(protected: protected, payload: vector.payload.data) == signature.toBeSigned.data)
        }
    }

    @Test(arguments: validNames)
    func v4TheSignaturesVerifyAndCryptoKitsDoToo(name: String) throws {
        let vector = Self.valid(name)

        for signature in vector.signatures {
            let key = try TestKey.named(signature.key)
            #expect(key.publicKey.verifies(signature.signature.data, over: signature.toBeSigned.data))
            let ours = try key.sign(signature.toBeSigned.data)
            #expect(ours.count == 64)
            #expect(key.publicKey.verifies(ours, over: signature.toBeSigned.data))
        }
    }

    @Test(arguments: validNames)
    func v5AssemblingAndAppendingGiveTheEnvelope(name: String) throws {
        let vector = Self.valid(name)
        let payload = try ResultPayload(bytes: vector.payload.data)
        let signatures = try vector.signatures.map { signature in
            try ResultSignature(
                kid: try KeyID(bytes: signature.kid.data),
                side: try #require(MatchResult.Side(rawValue: signature.side)),
                signature: signature.signature.data
            )
        }

        let assembled = try SignedResult(payload: payload, signatures: signatures)
        #expect(assembled.bytes == vector.envelope.data)

        guard signatures.count >= 2 else { return }
        let others = try SignedResult(bytes: try SignedResult(payload: payload, signatures: Array(signatures.dropLast())).bytes)
        let appended = try SignedResult(payload: others.payload, signatures: others.signatures + [signatures.last!])
        #expect(appended.bytes == vector.envelope.data)
    }

    @Test(arguments: validNames)
    func v5TheSecondSignerAppendsOverTheReceivedPayload(name: String) throws {
        let vector = Self.valid(name)
        guard vector.signatures.count >= 2, let last = vector.signatures.last else { return }
        let received = try SignedResult(bytes: vector.envelope.data)
        let truncated = try SignedResult(payload: received.payload, signatures: Array(received.signatures.dropLast()))

        let appended = try truncated.appendingSignature(
            for: try #require(MatchResult.Side(rawValue: last.side)),
            with: TestKey.named(last.key)
        )

        #expect(appended.payload.bytes == vector.payload.data)
        #expect(appended.signatures.dropLast() == received.signatures.dropLast())
        let mine = try #require(appended.signatures.last)
        #expect(mine.protected == last.protected.data)
        #expect(try TestKey.named(last.key).publicKey.verifies(mine.signature, over: last.toBeSigned.data))
    }

    @Test(arguments: validNames)
    func v6TheQRTextAndTheLinkRoundTrip(name: String) throws {
        let vector = Self.valid(name)
        let envelope = try SignedResult(bytes: vector.envelope.data)

        #expect(envelope.qrText == vector.qr)
        #expect(envelope.link == vector.link)
        #expect(try SignedResult(text: vector.qr).bytes == vector.envelope.data)
        #expect(try SignedResult(text: vector.link).bytes == vector.envelope.data)
    }

    @Test(arguments: validNames)
    func v7TheQRTextFitsVersion16AtLevelM(name: String) {
        let vector = Self.valid(name)
        let alphanumeric = Set("0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:")

        #expect(vector.qr.allSatisfy(alphanumeric.contains))
        if vector.signatures.count <= 2 {
            #expect(vector.qr.count <= 656)
        }
    }

    @Test(arguments: registrationNames)
    func r1TheProofsPartsMatch(name: String) throws {
        let vector = try #require(Self.vectors.registrations.first { $0.name == name })
        let key = try TestKey.named(vector.key)

        let protected = RegistrationProof.protected(kid: key.publicKey.kid)
        let payload = RegistrationProof.payload(account: vector.account)

        #expect(protected == vector.protected.data)
        #expect(payload == vector.payload.data)
        #expect(RegistrationProof.toBeSigned(protected: protected, payload: payload) == vector.toBeSigned.data)
    }

    @Test(arguments: registrationNames)
    func r2TheProofDiffersOnlyInItsSignature(name: String) throws {
        let vector = try #require(Self.vectors.registrations.first { $0.name == name })
        let key = try TestKey.named(vector.key)
        #expect(key.publicKey.verifies(vector.signature.data, over: vector.toBeSigned.data))

        let proof = try RegistrationProof.make(account: vector.account, key: key)

        #expect(proof.count == 160)
        #expect(proof.dropLast(64) == vector.proof.data.dropLast(64))
        #expect(key.publicKey.verifies(proof.suffix(64), over: vector.toBeSigned.data))
    }

    @Test(arguments: invalidNames)
    func i2OnlyAMalformedVectorIsRefusedAtDecode(name: String) throws {
        let vector = try #require(Self.vectors.invalid.first { $0.name == name })

        let decode = {
            if let text = vector.text {
                _ = try SignedResult(text: text)
            } else {
                _ = try SignedResult(bytes: try #require(vector.envelope).data)
            }
        }

        if vector.error == "malformed" {
            #expect(throws: Malformed.self, performing: decode)
        } else {
            #expect(throws: Never.self, performing: decode)
        }
    }

    /// Swift compares `Character`s and `String`s by canonical equivalence, so
    /// U+212A KELVIN SIGN equals `K`. The alphabets hold only `K`, and no
    /// shared vector carries the sign.
    @Test func aKelvinSignIsNotK() {
        let vector = Self.valid("completed-best-of-3")
        let qr = vector.qr.replacingOccurrences(of: "K", with: "\u{212A}", options: .literal)
        #expect(!qr.utf8.elementsEqual(vector.qr.utf8))

        #expect(throws: Malformed.self) { try SignedResult(text: qr) }
        #expect(throws: Malformed.self) { try SignedResult(text: "https://fortymm.com/r#\u{212A}") }
    }

    @Test func aSignedResultDecodesAsItWasSigned() throws {
        let vector = Self.valid("completed-best-of-3")
        let payload = try ResultPayload(issuedAt: vector.issuedAt, result: vector.result.matchResult)

        let half = try SignedResult.sign(payload, for: .first, with: TestKey.named("ann"))
        let full = try SignedResult(text: half.qrText).appendingSignature(for: .second, with: TestKey.named("bo"))

        let read = try SignedResult(text: full.link)
        #expect(read.payload == payload)
        #expect(read.signatures.map(\.kid) == [try TestKey.named("ann").publicKey.kid, try TestKey.named("bo").publicKey.kid])
        #expect(read.signatures.map(\.side) == [.first, .second])
    }
}
