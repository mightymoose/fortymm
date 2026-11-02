import CryptoKit
import Foundation

/// A key's RFC 9679 thumbprint, the SHA-256 of its COSE_Key bytes. Every
/// signature cites it.
struct KeyId: Hashable, Sendable {
    let bytes: Data

    init?(_ bytes: Data) {
        guard bytes.count == SHA256.byteCount else { return nil }
        self.bytes = bytes
    }

    var hex: String { bytes.hex }
}

/// A P-256 public key as the format encodes it.
struct SigningPublicKey: Equatable, Sendable {
    /// `{1: 2, -1: 1, -2: x, -3: y}`: kty EC2, crv P-256 and the
    /// coordinates. 75 bytes.
    let coseKey: Data
    let kid: KeyId

    init(_ key: P256.Signing.PublicKey) {
        let point = key.rawRepresentation
        coseKey = CBOR.map([
            .unsigned(1): .unsigned(2),
            .negative(0): .unsigned(1),
            .negative(1): .bytes(Data(point.prefix(32))),
            .negative(2): .bytes(Data(point.suffix(32))),
        ]).encoded
        kid = KeyId(Data(SHA256.hash(data: coseKey)))!
    }
}

/// A device's signing key: a Secure Enclave key on a device, a software key
/// on the Simulator and in tests. It signs with ES256 and gives the raw
/// 64-byte `r || s` the format wants.
struct SigningKey: Sendable {
    let publicKey: SigningPublicKey
    private let signer: @Sendable (Data) throws -> P256.Signing.ECDSASignature

    init(software key: P256.Signing.PrivateKey) {
        publicKey = SigningPublicKey(key.publicKey)
        signer = { try key.signature(for: $0) }
    }

    init(secureEnclave key: SecureEnclave.P256.Signing.PrivateKey) {
        publicKey = SigningPublicKey(key.publicKey)
        signer = { try key.signature(for: $0) }
    }

    func sign(_ message: Data) throws -> Data {
        try signer(message).rawRepresentation
    }
}

/// The COSE_Sign1 that registers a key to an account, as
/// api/signed-results/README.md specifies. 160 bytes. Every byte but the
/// signature is fixed by the key and the account.
enum RegistrationProof {
    static func protectedHeader(kid: KeyId) -> Data {
        CBOR.map([.unsigned(1): .negative(6), .unsigned(4): .bytes(kid.bytes)]).encoded
    }

    static func payload(account: UUID) -> Data {
        CBOR.map([.text("fortymm/key-registration/v1"): .map([.unsigned(1): .bytes(account.bytes)])]).encoded
    }

    static func toBeSigned(protected: Data, payload: Data) -> Data {
        CBOR.array([.text("Signature1"), .bytes(protected), .bytes(Data()), .bytes(payload)]).encoded
    }

    static func make(key: SigningKey, account: UUID) throws -> Data {
        let protected = protectedHeader(kid: key.publicKey.kid)
        let payload = payload(account: account)
        let signature = try key.sign(toBeSigned(protected: protected, payload: payload))
        return CBOR.tagged(18, .array([.bytes(protected), CBOR.emptyMap, .bytes(payload), .bytes(signature)])).encoded
    }
}

extension Data {
    /// Lowercase hex, as the API writes bytes.
    var hex: String {
        map { String(format: "%02x", $0) }.joined()
    }
}
