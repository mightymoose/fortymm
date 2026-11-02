import Foundation

/// One COSE_Signature: the key with `kid` approves the result for `side`.
struct ResultSignature: Equatable, Sendable {
    /// The signer's protected header, as signed.
    let protected: Data
    let kid: KeyId
    let side: Side
    /// ES256, raw `r || s`.
    let signature: Data

    static func protectedHeader(kid: KeyId, side: Side) -> Data {
        CBOR.map([
            .unsigned(1): .negative(6),
            .unsigned(4): .bytes(kid.bytes),
            .text("player"): .unsigned(side.rawValue),
        ]).encoded
    }

    /// Reads a signature from its protected header and signature bytes.
    init(protected: Data, signature: Data) throws(Malformed) {
        guard signature.count == 64 else { throw Malformed("a signature isn't 64 bytes") }
        let header = try CBOR.decode(protected).map(required: [.unsigned(1), .unsigned(4), .text("player")])
        guard header[.unsigned(1)] == .negative(6) else { throw Malformed("a signer's alg isn't ES256") }
        self.protected = protected
        kid = KeyId(try header[.unsigned(4)]!.bytes(count: 32))!
        side = try Payload.side(header[.text("player")]!)
        self.signature = signature
    }

    fileprivate init(_ item: CBOR) throws(Malformed) {
        let parts = try item.array(count: 3)
        guard parts[1] == CBOR.emptyMap else { throw Malformed("a signer's unprotected header isn't empty") }
        try self.init(protected: try parts[0].bytes(), signature: try parts[2].bytes())
    }

    fileprivate var cbor: CBOR {
        .array([.bytes(protected), CBOR.emptyMap, .bytes(signature)])
    }
}

/// A match result with its players' signatures: the COSE_Sign envelope of
/// api/signed-results/README.md. The payload's bytes are kept as they came,
/// because a re-encoded payload is another result. The app reads and signs
/// envelopes, and checks no signature: only the server verifies.
struct SignedResult: Equatable, Sendable {
    static let qrPrefix = "FMR1:"
    static let linkPrefix = "https://fortymm.com/r#"

    let payload: Data
    let result: MatchResult
    let issuedAt: IssuedAt
    /// Never empty, in envelope order.
    let signatures: [ResultSignature]

    var hash: ResultHash { ResultHash(of: payload) }

    private init(payload: Data, result: MatchResult, issuedAt: IssuedAt, signatures: [ResultSignature]) {
        self.payload = payload
        self.result = result
        self.issuedAt = issuedAt
        self.signatures = signatures
    }

    /// A new envelope that `key` signs for `side`.
    static func sign(_ result: MatchResult, issuedAt: IssuedAt, key: SigningKey, side: Side) throws -> SignedResult {
        let payload = Payload.encode(result, issuedAt: issuedAt)
        let signature = try signature(over: payload, key: key, side: side)
        return SignedResult(payload: payload, result: result, issuedAt: issuedAt, signatures: [signature])
    }

    /// What the second signer does: sign the received payload bytes, and add
    /// the signature.
    func countersigned(by key: SigningKey, side: Side) throws -> SignedResult {
        appending(try Self.signature(over: payload, key: key, side: side))
    }

    func appending(_ signature: ResultSignature) -> SignedResult {
        SignedResult(payload: payload, result: result, issuedAt: issuedAt, signatures: signatures + [signature])
    }

    /// The Sig_structure a signer signs: `["Signature", h'', protected, h'',
    /// payload]`.
    static func toBeSigned(protected: Data, payload: Data) -> Data {
        CBOR.array([.text("Signature"), .bytes(Data()), .bytes(protected), .bytes(Data()), .bytes(payload)]).encoded
    }

    private static func signature(over payload: Data, key: SigningKey, side: Side) throws -> ResultSignature {
        let protected = ResultSignature.protectedHeader(kid: key.publicKey.kid, side: side)
        let signature = try key.sign(toBeSigned(protected: protected, payload: payload))
        return try ResultSignature(protected: protected, signature: signature)
    }

    var bytes: Data {
        CBOR.tagged(98, .array([.bytes(Data()), CBOR.emptyMap, .bytes(payload), .array(signatures.map(\.cbor))])).encoded
    }

    var qrText: String { Self.qrPrefix + Base45.encode(bytes) }
    var link: String { Self.linkPrefix + Base64URL.encode(bytes) }

    /// Reads envelope bytes. Throws for anything that isn't the format, from
    /// the bytes alone.
    init(bytes: Data) throws(Malformed) {
        guard case .tagged(98, let body) = try CBOR.decode(bytes) else { throw Malformed("not a COSE_Sign (tag 98)") }
        let parts = try body.array(count: 4)
        guard parts[0] == .bytes(Data()) else { throw Malformed("the body protected header isn't h''") }
        guard parts[1] == CBOR.emptyMap else { throw Malformed("the body unprotected header isn't empty") }
        let payload = try parts[2].bytes()
        var signatures: [ResultSignature] = []
        for item in try parts[3].array() { signatures.append(try ResultSignature(item)) }
        try self.init(payload: payload, signatures: signatures)
    }

    /// An envelope of received payload bytes and signatures.
    init(payload: Data, signatures: [ResultSignature]) throws(Malformed) {
        (result, issuedAt) = try Payload.decode(payload)
        guard !signatures.isEmpty else { throw Malformed("no signatures") }
        self.payload = payload
        self.signatures = signatures
    }

    /// Reads a QR text or a link, told apart by prefix.
    init(text: String) throws(Malformed) {
        if text.hasPrefix(Self.qrPrefix) {
            try self.init(bytes: try Base45.decode(String(text.dropFirst(Self.qrPrefix.count))))
        } else if text.hasPrefix(Self.linkPrefix) {
            try self.init(bytes: try Base64URL.decode(String(text.dropFirst(Self.linkPrefix.count))))
        } else {
            throw Malformed("neither a QR text nor a link")
        }
    }
}

/// RFC 9285.
enum Base45 {
    private static let alphabet = Array("0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:")

    static func encode(_ data: Data) -> String {
        let bytes = [UInt8](data)
        var out = ""
        for start in stride(from: 0, to: bytes.count, by: 2) {
            let chunk = bytes[start..<min(start + 2, bytes.count)]
            var n = chunk.reduce(0) { $0 << 8 | Int($1) }
            for _ in 0...chunk.count {
                out.append(alphabet[n % 45])
                n /= 45
            }
        }
        return out
    }

    /// Strict: refuses a character outside the alphabet, a length of 1 mod 3,
    /// and a group worth more than its bytes hold.
    static func decode(_ text: String) throws(Malformed) -> Data {
        var digits: [Int] = []
        for character in text {
            guard let digit = alphabet.firstIndex(of: character) else { throw Malformed("not Base45") }
            digits.append(digit)
        }
        guard digits.count % 3 != 1 else { throw Malformed("a Base45 text 1 mod 3 characters long") }
        var out = Data()
        for start in stride(from: 0, to: digits.count, by: 3) {
            let group = digits[start..<min(start + 3, digits.count)]
            let n = group.reversed().reduce(0) { $0 * 45 + $1 }
            let byteCount = group.count - 1
            guard n < 1 << (8 * byteCount) else { throw Malformed("a Base45 group too large") }
            if byteCount == 2 { out.append(UInt8(n >> 8)) }
            out.append(UInt8(n & 0xFF))
        }
        return out
    }
}

/// RFC 4648 section 5, without padding.
enum Base64URL {
    static func encode(_ data: Data) -> String {
        data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    /// Strict: the bytes must encode back to `text`, which refuses padding,
    /// the standard alphabet and nonzero spare bits.
    static func decode(_ text: String) throws(Malformed) -> Data {
        let standard = text
            .replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        let padded = standard + String(repeating: "=", count: (4 - standard.count % 4) % 4)
        guard let data = Data(base64Encoded: padded), encode(data) == text else {
            throw Malformed("not unpadded base64url")
        }
        return data
    }
}
