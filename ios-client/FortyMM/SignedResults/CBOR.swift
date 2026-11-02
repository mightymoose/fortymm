import Foundation

/// Bytes that aren't the signed result format, decided from the bytes alone
/// (`malformed` in api/signed-results/README.md).
struct Malformed: Error, Equatable {}

/// A CBOR data item (RFC 8949), with only the kinds the signed result format
/// uses. There are no floats, no null and no indefinite lengths, so a
/// decoder that meets one refuses it.
indirect enum CBOR: Equatable, Sendable {
    struct Entry: Equatable, Sendable {
        let key: CBOR
        let value: CBOR
    }

    case unsigned(UInt64)
    /// The integer `-1 - n`.
    case negative(UInt64)
    case bytes(Data)
    case text(String)
    case array([CBOR])
    case map([Entry])
    case tagged(UInt64, CBOR)
    case bool(Bool)

    static func int(_ value: Int64) -> CBOR {
        value >= 0 ? .unsigned(UInt64(value)) : .negative(UInt64(-1 - value))
    }

    /// The core deterministic encoding of RFC 8949 section 4.2.1: shortest
    /// heads, definite lengths, and map keys sorted by their encoded bytes.
    var encoded: Data {
        var out = Data()
        write(to: &out)
        return out
    }

    /// Decodes `data` as exactly one item in deterministic CBOR. Anything
    /// else, such as trailing bytes, a non-shortest head, unsorted or repeated
    /// map keys, or an item kind outside `CBOR`, is `Malformed`.
    init(deterministic data: Data) throws(Malformed) {
        var reader = Reader(bytes: [UInt8](data))
        let item = try reader.item()
        guard reader.atEnd, item.encoded == data else { throw Malformed() }
        self = item
    }

    private func write(to out: inout Data) {
        switch self {
        case .unsigned(let value):
            Self.head(0, value, &out)
        case .negative(let value):
            Self.head(1, value, &out)
        case .bytes(let data):
            Self.head(2, UInt64(data.count), &out)
            out.append(data)
        case .text(let text):
            let data = Data(text.utf8)
            Self.head(3, UInt64(data.count), &out)
            out.append(data)
        case .array(let items):
            Self.head(4, UInt64(items.count), &out)
            for item in items { item.write(to: &out) }
        case .map(let entries):
            let pairs = entries
                .map { (key: $0.key.encoded, value: $0.value.encoded) }
                .sorted { $0.key.lexicographicallyPrecedes($1.key) }
            Self.head(5, UInt64(pairs.count), &out)
            for pair in pairs {
                out.append(pair.key)
                out.append(pair.value)
            }
        case .tagged(let tag, let item):
            Self.head(6, tag, &out)
            item.write(to: &out)
        case .bool(let value):
            out.append(value ? 0xf5 : 0xf4)
        }
    }

    private static func head(_ major: UInt8, _ argument: UInt64, _ out: inout Data) {
        let type = major << 5
        let (info, width): (UInt8, Int) = switch argument {
        case ..<24: (UInt8(argument), 0)
        case ..<0x100: (24, 1)
        case ..<0x1_0000: (25, 2)
        case ..<0x1_0000_0000: (26, 4)
        default: (27, 8)
        }
        out.append(type | info)
        for shift in stride(from: (width - 1) * 8, through: 0, by: -8) {
            out.append(UInt8(truncatingIfNeeded: argument >> UInt64(shift)))
        }
    }
}

private struct Reader {
    /// Deeper than any item in the format, so a crafted input can't exhaust
    /// the stack.
    static let maxDepth = 16

    let bytes: [UInt8]
    var index = 0
    var depth = 0

    var atEnd: Bool { index == bytes.count }

    mutating func item() throws(Malformed) -> CBOR {
        depth += 1
        defer { depth -= 1 }
        guard depth <= Self.maxDepth else { throw Malformed() }

        let initial = try byte()
        let major = initial >> 5
        let info = initial & 0x1f
        if major == 7 {
            switch info {
            case 20: return .bool(false)
            case 21: return .bool(true)
            default: throw Malformed()
            }
        }
        let argument = try argument(info)
        switch major {
        case 0:
            return .unsigned(argument)
        case 1:
            return .negative(argument)
        case 2:
            return .bytes(try take(argument))
        case 3:
            guard let text = String(data: try take(argument), encoding: .utf8) else { throw Malformed() }
            return .text(text)
        case 4:
            try fits(argument)
            var items: [CBOR] = []
            for _ in 0..<argument { items.append(try item()) }
            return .array(items)
        case 5:
            try fits(argument)
            var entries: [CBOR.Entry] = []
            var previous: Data?
            for _ in 0..<argument {
                let key = try item()
                // Each key sorts strictly after the last, which also refuses
                // a repeated key, in one pass.
                let encoded = key.encoded
                if let previous, !previous.lexicographicallyPrecedes(encoded) { throw Malformed() }
                previous = encoded
                entries.append(CBOR.Entry(key: key, value: try item()))
            }
            return .map(entries)
        default:
            return .tagged(argument, try item())
        }
    }

    private mutating func byte() throws(Malformed) -> UInt8 {
        guard index < bytes.count else { throw Malformed() }
        defer { index += 1 }
        return bytes[index]
    }

    /// The head's argument. 28 to 30 are reserved and 31 is an indefinite
    /// length, so both are refused.
    private mutating func argument(_ info: UInt8) throws(Malformed) -> UInt64 {
        let width: Int
        switch info {
        case ..<24: return UInt64(info)
        case 24: width = 1
        case 25: width = 2
        case 26: width = 4
        case 27: width = 8
        default: throw Malformed()
        }
        var value: UInt64 = 0
        for _ in 0..<width { value = value << 8 | UInt64(try byte()) }
        return value
    }

    private mutating func take(_ count: UInt64) throws(Malformed) -> Data {
        try fits(count)
        let start = index
        index += Int(count)
        return Data(bytes[start..<index])
    }

    /// Every item takes at least one byte, so a count past the bytes left is
    /// refused before anything is allocated for it.
    private func fits(_ count: UInt64) throws(Malformed) {
        guard count <= UInt64(bytes.count - index) else { throw Malformed() }
    }
}
