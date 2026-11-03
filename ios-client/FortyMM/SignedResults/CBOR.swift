import Foundation

/// The bytes aren't the signed result format. `reason` is for people. No
/// code matches on it.
struct Malformed: Error, Equatable {
    let reason: String

    init(_ reason: String) {
        self.reason = reason
    }
}

/// One CBOR item (RFC 8949), as much of CBOR as the signed result format
/// uses. There's no float, null or indefinite length, so the decoder can't
/// produce one.
indirect enum CBOR: Hashable, Sendable {
    case unsigned(UInt64)
    /// The integer -1 - n, as CBOR's major type 1 stores it.
    case negative(UInt64)
    case bytes(Data)
    case text(String)
    case array([CBOR])
    case map([CBOR: CBOR])
    case tagged(UInt64, CBOR)
    case bool(Bool)

    /// The core deterministic encoding: shortest heads, definite lengths,
    /// and map keys sorted by the bytes of their encoding.
    var encoded: Data {
        var out = Data()
        append(to: &out)
        return out
    }

    private func append(to out: inout Data) {
        switch self {
        case .unsigned(let n):
            Self.head(0, n, to: &out)
        case .negative(let n):
            Self.head(1, n, to: &out)
        case .bytes(let bytes):
            Self.head(2, UInt64(bytes.count), to: &out)
            out.append(bytes)
        case .text(let text):
            let utf8 = Data(text.utf8)
            Self.head(3, UInt64(utf8.count), to: &out)
            out.append(utf8)
        case .array(let items):
            Self.head(4, UInt64(items.count), to: &out)
            for item in items { item.append(to: &out) }
        case .map(let entries):
            Self.head(5, UInt64(entries.count), to: &out)
            let sorted = entries
                .map { (key: $0.key.encoded, value: $0.value) }
                .sorted { $0.key.lexicographicallyPrecedes($1.key) }
            for entry in sorted {
                out.append(entry.key)
                entry.value.append(to: &out)
            }
        case .tagged(let tag, let item):
            Self.head(6, tag, to: &out)
            item.append(to: &out)
        case .bool(let value):
            out.append(value ? 0xF5 : 0xF4)
        }
    }

    private static func head(_ major: UInt8, _ value: UInt64, to out: inout Data) {
        let type = major << 5
        switch value {
        case ..<24:
            out.append(type | UInt8(value))
        case ...0xFF:
            out.append(type | 24)
            out.append(UInt8(value))
        case ...0xFFFF:
            out.append(type | 25)
            out.append(contentsOf: withUnsafeBytes(of: UInt16(value).bigEndian, Array.init))
        case ...0xFFFF_FFFF:
            out.append(type | 26)
            out.append(contentsOf: withUnsafeBytes(of: UInt32(value).bigEndian, Array.init))
        default:
            out.append(type | 27)
            out.append(contentsOf: withUnsafeBytes(of: value.bigEndian, Array.init))
        }
    }

    /// Decodes one item that must be in the deterministic encoding: encoding
    /// it again gives `data` exactly. That refuses trailing bytes,
    /// non-shortest heads and unsorted map keys. The decoder itself refuses
    /// floats, simple values other than booleans, indefinite lengths,
    /// duplicate map keys and text that isn't UTF-8.
    static func decode(_ data: Data) throws(Malformed) -> CBOR {
        var reader = Reader(bytes: [UInt8](data))
        let item = try reader.item(depth: 0)
        guard reader.offset == reader.bytes.count else { throw Malformed("bytes after the CBOR item") }
        guard item.encoded == data else { throw Malformed("not deterministic CBOR") }
        return item
    }

    private struct Reader {
        let bytes: [UInt8]
        var offset = 0

        /// Far deeper than the format nests, so hostile input can't
        /// overflow the stack.
        static let maxDepth = 16

        mutating func item(depth: Int) throws(Malformed) -> CBOR {
            guard depth < Self.maxDepth else { throw Malformed("nested too deep") }
            let initial = try take(1).first!
            let major = initial >> 5
            let info = initial & 0x1F
            if major == 7 {
                switch info {
                case 20: return .bool(false)
                case 21: return .bool(true)
                default: throw Malformed("a float or a simple value other than a boolean")
                }
            }
            let argument = try argument(info)
            switch major {
            case 0:
                return .unsigned(argument)
            case 1:
                return .negative(argument)
            case 2:
                return .bytes(Data(try take(argument)))
            case 3:
                guard let text = String(validating: try take(argument), as: UTF8.self) else {
                    throw Malformed("text that isn't UTF-8")
                }
                return .text(text)
            case 4:
                try ensureRoom(for: argument)
                var items: [CBOR] = []
                for _ in 0..<argument { items.append(try item(depth: depth + 1)) }
                return .array(items)
            case 5:
                try ensureRoom(for: argument)
                try ensureRoom(for: argument * 2)
                var entries: [CBOR: CBOR] = [:]
                for _ in 0..<argument {
                    let key = try item(depth: depth + 1)
                    let value = try item(depth: depth + 1)
                    guard entries.updateValue(value, forKey: key) == nil else { throw Malformed("a duplicate map key") }
                }
                return .map(entries)
            default:
                return .tagged(argument, try item(depth: depth + 1))
            }
        }

        private mutating func argument(_ info: UInt8) throws(Malformed) -> UInt64 {
            switch info {
            case ..<24: return UInt64(info)
            case 24: return try uint(bytes: 1)
            case 25: return try uint(bytes: 2)
            case 26: return try uint(bytes: 4)
            case 27: return try uint(bytes: 8)
            case 31: throw Malformed("an indefinite length")
            default: throw Malformed("a reserved additional information value")
            }
        }

        private mutating func uint(bytes count: UInt64) throws(Malformed) -> UInt64 {
            try take(count).reduce(0) { $0 << 8 | UInt64($1) }
        }

        /// Each item takes at least a byte, so a count beyond what's left is
        /// refused before anything is allocated for it.
        private func ensureRoom(for count: UInt64) throws(Malformed) {
            guard count <= UInt64(bytes.count - offset) else { throw Malformed("a length past the end") }
        }

        private mutating func take(_ count: UInt64) throws(Malformed) -> ArraySlice<UInt8> {
            try ensureRoom(for: count)
            let end = offset + Int(count)
            defer { offset = end }
            return bytes[offset..<end]
        }
    }
}

/// Reading an item as the exact type the format's tables give. Each read
/// that finds another type throws `Malformed`.
extension CBOR {
    func uint() throws(Malformed) -> UInt64 {
        guard case .unsigned(let n) = self else { throw Malformed("not an unsigned integer") }
        return n
    }

    func bool() throws(Malformed) -> Bool {
        guard case .bool(let value) = self else { throw Malformed("not a boolean") }
        return value
    }

    func bytes(count: Int? = nil) throws(Malformed) -> Data {
        guard case .bytes(let bytes) = self, count.map({ $0 == bytes.count }) ?? true else {
            throw Malformed("not a byte string\(count.map { " of \($0) bytes" } ?? "")")
        }
        return bytes
    }

    func array(count: Int? = nil) throws(Malformed) -> [CBOR] {
        guard case .array(let items) = self, count.map({ $0 == items.count }) ?? true else {
            throw Malformed("not an array\(count.map { " of \($0)" } ?? "")")
        }
        return items
    }

    /// A map whose keys are exactly `required` plus any of `optional`.
    func map(required: Set<CBOR>, optional: Set<CBOR> = []) throws(Malformed) -> [CBOR: CBOR] {
        guard case .map(let entries) = self else { throw Malformed("not a map") }
        let keys = Set(entries.keys)
        guard required.isSubset(of: keys), keys.isSubset(of: required.union(optional)) else {
            throw Malformed("a map with other keys")
        }
        return entries
    }

    static let emptyMap = CBOR.map([:])
}
