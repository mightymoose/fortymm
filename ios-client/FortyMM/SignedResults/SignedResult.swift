import Foundation

/// A device key that signs with ES256 and gives the raw `r || s`.
protocol MessageSigner: Sendable {
    var publicKey: SigningPublicKey { get }
    func sign(_ message: Data) throws -> Data
}

/// One COSE_Signature of a signed result: who signed, for which side, and
/// the 64-byte signature.
struct ResultSignature: Equatable, Sendable {
    let kid: KeyID
    let side: MatchResult.Side
    let signature: Data

    /// The signer's protected header, `{1: -7, 4: kid, "player": side}`.
    var protected: Data { Self.protected(kid: kid, side: side) }

    static func protected(kid: KeyID, side: MatchResult.Side) -> Data {
        CBOR.map([
            .init(key: .unsigned(COSE.alg), value: .int(COSE.es256)),
            .init(key: .unsigned(COSE.kid), value: .bytes(kid.bytes)),
            .init(key: .text(playerLabel), value: .unsigned(side.rawValue)),
        ]).encoded
    }

    /// The Sig_structure of RFC 9052 section 4.4 that the signature covers,
    /// `["Signature", h'', protected, h'', payload]`.
    static func toBeSigned(protected: Data, payload: Data) -> Data {
        CBOR.array([.text("Signature"), .bytes(Data()), .bytes(protected), .bytes(Data()), .bytes(payload)]).encoded
    }

    private static let playerLabel = "player"

    fileprivate var cbor: CBOR {
        .array([.bytes(protected), .map([]), .bytes(signature)])
    }

    init(kid: KeyID, side: MatchResult.Side, signature: Data) throws(Malformed) {
        guard signature.count == SigningPublicKey.signatureBytes else { throw Malformed() }
        self.kid = kid
        self.side = side
        self.signature = signature
    }

    fileprivate init(cbor: CBOR) throws(Malformed) {
        guard case .array(let parts) = cbor, parts.count == 3,
              case .bytes(let protected) = parts[0],
              parts[1] == .map([]),
              case .bytes(let signature) = parts[2]
        else { throw Malformed() }
        let header = try Fields(
            CBOR(deterministic: protected),
            keys: [.unsigned(COSE.alg), .unsigned(COSE.kid), .text(Self.playerLabel)]
        )
        guard try header.required(.unsigned(COSE.alg)) == .int(COSE.es256),
              let side = MatchResult.Side(rawValue: try header.unsigned(.text(Self.playerLabel)))
        else { throw Malformed() }
        try self.init(
            kid: KeyID(bytes: try header.bytes(.unsigned(COSE.kid), count: KeyID.byteCount)),
            side: side,
            signature: signature
        )
        guard self.protected == protected else { throw Malformed() }
    }
}

/// A signed result: the COSE_Sign envelope of api/signed-results/README.md
/// ("The envelope"), with at least one signature.
///
/// It keeps the payload's bytes as it got them. A second signer appends
/// over those bytes and never encodes the payload again.
struct SignedResult: Equatable, Sendable {
    let payload: ResultPayload
    let signatures: [ResultSignature]

    /// The QR text's prefix.
    static let qrPrefix = "FMR1:"
    /// The link's prefix. The envelope goes in the fragment, which never
    /// reaches a server.
    static let linkPrefix = "https://fortymm.com/r#"

    init(payload: ResultPayload, signatures: [ResultSignature]) throws(Malformed) {
        guard !signatures.isEmpty else { throw Malformed() }
        self.payload = payload
        self.signatures = signatures
    }

    /// Signs `payload` for `side` as its first signer.
    static func sign(_ payload: ResultPayload, for side: MatchResult.Side, with key: some MessageSigner) throws -> Self {
        try Self(payload: payload, signatures: [signature(over: payload, for: side, with: key)])
    }

    /// This result with one more signature, over the payload bytes it holds.
    func appendingSignature(for side: MatchResult.Side, with key: some MessageSigner) throws -> Self {
        try Self(payload: payload, signatures: signatures + [Self.signature(over: payload, for: side, with: key)])
    }

    /// Reads envelope bytes. Anything but an envelope this type would write
    /// byte for byte is `Malformed`.
    init(bytes: Data) throws(Malformed) {
        guard case .tagged(COSE.signTag, .array(let parts)) = try CBOR(deterministic: bytes), parts.count == 4,
              parts[0] == .bytes(Data()),
              parts[1] == .map([]),
              case .bytes(let payload) = parts[2],
              case .array(let items) = parts[3]
        else { throw Malformed() }
        var signatures: [ResultSignature] = []
        for item in items { signatures.append(try ResultSignature(cbor: item)) }
        try self.init(payload: ResultPayload(bytes: payload), signatures: signatures)
    }

    /// Reads a QR text or a link. It compares bytes, never `Character`s,
    /// which match by canonical equivalence.
    init(text: String) throws(Malformed) {
        func rest(after prefix: String) -> String? {
            guard text.utf8.starts(with: prefix.utf8) else { return nil }
            return String(decoding: text.utf8.dropFirst(prefix.utf8.count), as: UTF8.self)
        }
        if let base45 = rest(after: Self.qrPrefix) {
            try self.init(bytes: Base45.decode(base45))
        } else if let base64 = rest(after: Self.linkPrefix) {
            try self.init(bytes: Base64URL.decode(base64))
        } else {
            throw Malformed()
        }
    }

    var bytes: Data {
        CBOR.tagged(COSE.signTag, .array([
            .bytes(Data()),
            .map([]),
            .bytes(payload.bytes),
            .array(signatures.map(\.cbor)),
        ])).encoded
    }

    var qrText: String { Self.qrPrefix + Base45.encode(bytes) }
    var link: String { Self.linkPrefix + Base64URL.encode(bytes) }

    private static func signature(
        over payload: ResultPayload, for side: MatchResult.Side, with key: some MessageSigner
    ) throws -> ResultSignature {
        let kid = key.publicKey.kid
        let message = ResultSignature.toBeSigned(protected: ResultSignature.protected(kid: kid, side: side), payload: payload.bytes)
        return try ResultSignature(kid: kid, side: side, signature: key.sign(message))
    }
}

/// The COSE labels and values the formats use (RFC 9052, RFC 9053).
enum COSE {
    static let alg: UInt64 = 1
    static let kid: UInt64 = 4
    static let es256: Int64 = -7
    /// COSE_Sign.
    static let signTag: UInt64 = 98
    /// COSE_Sign1.
    static let sign1Tag: UInt64 = 18
}

/// Base45 (RFC 9285), the QR text's alphabet. `decode` is strict: its bytes
/// encode back to the same text.
enum Base45 {
    /// Bytes, not `Character`s: a `Character` compares by canonical
    /// equivalence, so U+212A KELVIN SIGN would pass as `K`.
    private static let alphabet = Array("0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:".utf8)

    static func encode(_ data: Data) -> String {
        String(decoding: encodedBytes(data), as: UTF8.self)
    }

    private static func encodedBytes(_ data: Data) -> [UInt8] {
        var out: [UInt8] = []
        let bytes = [UInt8](data)
        for start in stride(from: 0, to: bytes.count, by: 2) {
            if start + 1 < bytes.count {
                let value = Int(bytes[start]) * 256 + Int(bytes[start + 1])
                out.append(alphabet[value % 45])
                out.append(alphabet[value / 45 % 45])
                out.append(alphabet[value / 2025])
            } else {
                let value = Int(bytes[start])
                out.append(alphabet[value % 45])
                out.append(alphabet[value / 45])
            }
        }
        return out
    }

    static func decode(_ text: String) throws(Malformed) -> Data {
        var digits: [Int] = []
        for byte in text.utf8 {
            guard let digit = alphabet.firstIndex(of: byte) else { throw Malformed() }
            digits.append(digit)
        }
        guard digits.count % 3 != 1 else { throw Malformed() }
        var out = Data()
        for start in stride(from: 0, to: digits.count, by: 3) {
            if start + 2 < digits.count {
                let value = digits[start] + digits[start + 1] * 45 + digits[start + 2] * 2025
                guard value <= 0xffff else { throw Malformed() }
                out.append(UInt8(value >> 8))
                out.append(UInt8(value & 0xff))
            } else {
                let value = digits[start] + digits[start + 1] * 45
                guard value <= 0xff else { throw Malformed() }
                out.append(UInt8(value))
            }
        }
        guard encodedBytes(out).elementsEqual(text.utf8) else { throw Malformed() }
        return out
    }
}

/// Unpadded base64url (RFC 4648 section 5), the link's alphabet. `decode` is
/// strict: its bytes encode back to the same text.
enum Base64URL {
    static func encode(_ data: Data) -> String {
        data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    static func decode(_ text: String) throws(Malformed) -> Data {
        var base64 = text.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        base64 += String(repeating: "=", count: (4 - base64.count % 4) % 4)
        guard let data = Data(base64Encoded: base64), encode(data).utf8.elementsEqual(text.utf8) else { throw Malformed() }
        return data
    }
}
