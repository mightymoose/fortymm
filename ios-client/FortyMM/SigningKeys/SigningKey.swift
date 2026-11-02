import CryptoKit
import Foundation

/// A key's RFC 9679 thumbprint, the `kid` every signature cites and the id
/// the API knows the key by: the SHA-256 of its COSE_Key.
struct KeyID: Hashable, Sendable {
    static let byteCount = SHA256.byteCount

    let bytes: Data

    init(bytes: Data) throws(Malformed) {
        guard bytes.count == Self.byteCount else { throw Malformed() }
        self.bytes = bytes
    }

    /// Lowercase hex, as the API's JSON writes every byte field.
    var hex: String { bytes.hex }
}

/// A P-256 public key, as the formats encode it.
struct SigningPublicKey: Equatable, Sendable {
    static let signatureBytes = 64

    let key: P256.Signing.PublicKey

    /// The x and y coordinates, 32 bytes each, big-endian.
    var x: Data { key.x963Representation.dropFirst().prefix(32) }
    var y: Data { key.x963Representation.suffix(32) }

    /// The deterministic CBOR of `{1: 2, -1: 1, -2: x, -3: y}`, 75 bytes.
    var coseKey: Data {
        CBOR.map([
            .init(key: .int(1), value: .int(2)),
            .init(key: .int(-1), value: .int(1)),
            .init(key: .int(-2), value: .bytes(Data(x))),
            .init(key: .int(-3), value: .bytes(Data(y))),
        ]).encoded
    }

    var kid: KeyID {
        // A SHA-256 digest is always 32 bytes.
        try! KeyID(bytes: Data(SHA256.hash(data: coseKey)))
    }

    /// ES256 over `message`, with a raw `r || s` signature.
    func verifies(_ signature: Data, over message: Data) -> Bool {
        guard let signature = try? P256.Signing.ECDSASignature(rawRepresentation: signature) else { return false }
        return key.isValidSignature(signature, for: message)
    }

    static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.key.rawRepresentation == rhs.key.rawRepresentation
    }
}

/// The key registration proof of api/signed-results/README.md: a COSE_Sign1
/// of 160 bytes that registers a key to an account.
enum RegistrationProof {
    /// Not the result format's domain tag, so a proof can't pass as a result
    /// signature.
    static let tag = "fortymm/key-registration/v1"

    static func make(account: UUID, key: some MessageSigner) throws -> Data {
        let protected = protected(kid: key.publicKey.kid)
        let payload = payload(account: account)
        let signature = try key.sign(toBeSigned(protected: protected, payload: payload))
        return CBOR.tagged(COSE.sign1Tag, .array([.bytes(protected), .map([]), .bytes(payload), .bytes(signature)])).encoded
    }

    /// `{1: -7, 4: kid}`.
    static func protected(kid: KeyID) -> Data {
        CBOR.map([
            .init(key: .unsigned(COSE.alg), value: .int(COSE.es256)),
            .init(key: .unsigned(COSE.kid), value: .bytes(kid.bytes)),
        ]).encoded
    }

    /// `{"fortymm/key-registration/v1": {1: account}}`.
    static func payload(account: UUID) -> Data {
        CBOR.map([
            .init(key: .text(tag), value: .map([.init(key: .unsigned(1), value: .bytes(account.data))])),
        ]).encoded
    }

    /// `["Signature1", protected, h'', payload]`.
    static func toBeSigned(protected: Data, payload: Data) -> Data {
        CBOR.array([.text("Signature1"), .bytes(protected), .bytes(Data()), .bytes(payload)]).encoded
    }
}

/// The device's signing key. Where the device has a Secure Enclave, the
/// private key lives there and never leaves it. The Simulator has none, so
/// there the key is a software key that only the Keychain holds. Everything
/// above this type works the same either way.
struct DeviceKey: MessageSigner {
    private enum Material: Sendable {
        case secureEnclave(SecureEnclave.P256.Signing.PrivateKey)
        case software(P256.Signing.PrivateKey)
    }

    /// What the Keychain keeps. A Secure Enclave key's data is a handle that
    /// only this device's Secure Enclave can use.
    struct Stored: Codable, Equatable, Sendable {
        enum Kind: String, Codable, Sendable {
            case secureEnclave
            case software
        }

        let kind: Kind
        let data: Data
    }

    private let material: Material

    /// A new key, in the Secure Enclave if the device has one.
    static func make() throws -> DeviceKey {
        if SecureEnclave.isAvailable {
            return DeviceKey(material: .secureEnclave(try SecureEnclave.P256.Signing.PrivateKey()))
        }
        return DeviceKey(material: .software(P256.Signing.PrivateKey()))
    }

    init(stored: Stored) throws {
        switch stored.kind {
        case .secureEnclave:
            material = .secureEnclave(try SecureEnclave.P256.Signing.PrivateKey(dataRepresentation: stored.data))
        case .software:
            material = .software(try P256.Signing.PrivateKey(rawRepresentation: stored.data))
        }
    }

    private init(material: Material) {
        self.material = material
    }

    var stored: Stored {
        switch material {
        case .secureEnclave(let key): Stored(kind: .secureEnclave, data: key.dataRepresentation)
        case .software(let key): Stored(kind: .software, data: key.rawRepresentation)
        }
    }

    var publicKey: SigningPublicKey {
        switch material {
        case .secureEnclave(let key): SigningPublicKey(key: key.publicKey)
        case .software(let key): SigningPublicKey(key: key.publicKey)
        }
    }

    func sign(_ message: Data) throws -> Data {
        switch material {
        case .secureEnclave(let key): try key.signature(for: message).rawRepresentation
        case .software(let key): try key.signature(for: message).rawRepresentation
        }
    }
}

extension Data {
    var hex: String { map { String(format: "%02x", $0) }.joined() }
}
