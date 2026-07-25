import Foundation

/// A Server-Sent Events frame reader: bytes in, decoded frames out.
///
/// This is the one place the wire format of `GET /v1/stream` is understood. It
/// is deliberately **pure and synchronous** — no `URLSession`, no timers, no
/// network — because the interesting failures are all *framing* failures (a
/// chunk boundary landing mid-field, a `\r` split from its `\n`, a keepalive
/// comment mistaken for an event), and those are only cheap to test when the
/// reader takes bytes and nothing else. It mirrors
/// `web-client/src/api/realtime/sse-frames.ts`; keep the two in step.
///
/// Follows the WHATWG "event stream interpretation" algorithm, with two
/// deliberate departures:
///
/// - **`id:` is parsed and dropped.** Our hints are idempotent and carry no
///   sequence, so a reconnect self-heals by refetching rather than by replaying
///   from a `Last-Event-ID` cursor. Keeping an id would imply a replay log the
///   server does not have.
/// - **`retry:` is surfaced to the caller** as its own frame rather than being
///   swallowed as connection state. The server sends one as the very first
///   frame (jittered), and the reconnect policy that honours it lives above
///   this type (`RealtimeReconnect`) — on iOS nothing does it for us the way
///   the browser's `EventSource` does.
///
/// ## Why it buffers BYTES, not text
///
/// Decoding each arriving chunk to a `String` on its own corrupts a multi-byte
/// character that straddles a chunk boundary (a 4-byte emoji cut in half
/// becomes two replacement characters). Buffering bytes and decoding only
/// *complete lines* makes that unrepresentable: line terminators are ASCII, so
/// a line boundary can never fall inside a UTF-8 sequence.
enum SSEFrame: Equatable {
    /// The reconnect base delay the server asked for, in milliseconds.
    case retry(milliseconds: Int)
    /// A dispatched event: its `data` payload, plus the `event:` name
    /// (`"message"` when the server sent an unnamed event, which is all ours
    /// are).
    case message(event: String, data: String)

    /// The event type a frame with no `event:` field dispatches as, per the spec.
    static let defaultEventType = "message"
}

/// Incremental reader: feed it whatever bytes arrived, take back whatever
/// frames those bytes completed.
///
/// A value type holding two pieces of carry-over state — the bytes of a line
/// that has not ended yet, and the fields of a block that has not been
/// dispatched yet — so a caller only has to hand it chunks in order.
///
/// A trailing **partial** block at end of stream is discarded rather than
/// emitted: a truncated frame is not an event, and there is deliberately no
/// `finish()` that could emit one.
struct SSEFrameParser {
    private static let carriageReturn: UInt8 = 0x0D
    private static let lineFeed: UInt8 = 0x0A

    /// Bytes received but not yet terminated by a line ending.
    private var buffer: [UInt8] = []
    /// The block being accumulated, dispatched on the next blank line.
    private var block = Block()

    init() {}

    /// Consume a chunk, returning the frames it completed, in wire order.
    ///
    /// Chunk boundaries are meaningless here: `consume` may be handed a whole
    /// transcript, one frame, or a single byte, and the frames it yields across
    /// a run are identical either way.
    mutating func consume(_ bytes: some Sequence<UInt8>) -> [SSEFrame] {
        buffer.append(contentsOf: bytes)

        var frames: [SSEFrame] = []
        var lineStart = 0
        var index = 0
        while index < buffer.count {
            let byte = buffer[index]
            guard byte == Self.carriageReturn || byte == Self.lineFeed else {
                index += 1
                continue
            }
            // A `\r` at the very end of the buffer may be the first half of a
            // `\r\n` whose `\n` is in the next chunk, so it is held back rather
            // than treated as a terminator. Without that, a chunk boundary
            // between the two manufactures a spurious blank line and dispatches
            // half a frame.
            if byte == Self.carriageReturn, index == buffer.count - 1 { break }

            // Safe to decode: the terminator is ASCII, so this slice ends on a
            // character boundary even if the chunk did not.
            let line = String(decoding: buffer[lineStart..<index], as: UTF8.self)
            let terminatorLength =
                (byte == Self.carriageReturn && buffer[index + 1] == Self.lineFeed) ? 2 : 1
            frames.append(contentsOf: accept(line: line))
            index += terminatorLength
            lineStart = index
        }
        buffer.removeFirst(lineStart)
        return frames
    }

    /// One line: a blank line dispatches the accumulated block, anything else
    /// contributes to it.
    private mutating func accept(line: String) -> [SSEFrame] {
        guard !line.isEmpty else { return dispatch() }
        apply(line: line)
        return []
    }

    /// Decode one field line into the block being accumulated.
    ///
    /// A line is a comment (dropped), a field with a value, or a bare field
    /// name (value `""`). Exactly one optional space after the colon is
    /// stripped, so `data: x` and `data:x` both carry `x`.
    private mutating func apply(line: String) {
        if line.hasPrefix(":") { return } // keepalive / comment

        let field: Substring
        var value: Substring
        if let colon = line.firstIndex(of: ":") {
            field = line[line.startIndex..<colon]
            value = line[line.index(after: colon)...]
            if value.hasPrefix(" ") { value = value.dropFirst() }
        } else {
            field = line[...]
            value = ""
        }

        switch field {
        case "data":
            // The spec appends value + U+000A; the trailing newline comes off at
            // dispatch, which is what joins multi-line data with a single "\n".
            block.data += value + "\n"
        case "event":
            block.event = String(value)
        case "retry":
            // Non-digits are ignored rather than coerced: `retry: soon` must not
            // become a garbage reconnect delay.
            if let milliseconds = Self.parseRetry(value) { block.retry = milliseconds }
        default:
            // `id:` and anything a newer server invents are ignored, per the spec.
            break
        }
    }

    /// The frames a completed block dispatches, in wire order.
    private mutating func dispatch() -> [SSEFrame] {
        var frames: [SSEFrame] = []
        if let retry = block.retry { frames.append(.retry(milliseconds: retry)) }
        // A block with no `data:` at all (a lone `retry:`, or a block of
        // comments) dispatches no event — that is the spec ("If the data buffer
        // is an empty string, … abort these steps"), and it is why `: ping` is
        // invisible to the caller instead of arriving as an empty message.
        //
        // Emptiness is the whole test, because every `data:` line — including a
        // bare `data:` with no value — appends at least the U+000A the spec
        // mandates. So a block whose only line is `data:` has a non-empty buffer
        // ("\n") and correctly dispatches an event with empty data.
        if !block.data.isEmpty {
            var data = block.data
            if data.hasSuffix("\n") { data.removeLast() }
            frames.append(
                .message(
                    event: block.event.isEmpty ? SSEFrame.defaultEventType : block.event,
                    data: data
                )
            )
        }
        block = Block()
        return frames
    }

    /// ASCII digits only, and only a value an `Int` can actually hold.
    private static func parseRetry(_ value: Substring) -> Int? {
        guard !value.isEmpty,
              value.unicodeScalars.allSatisfy({ $0.value >= 48 && $0.value <= 57 })
        else { return nil }
        return Int(value)
    }

    /// The fields accumulated since the last blank line.
    private struct Block {
        /// The spec's "data buffer". Only ever appended to as `value + "\n"`, so
        /// its emptiness *is* "this block had no `data:` line" — see `dispatch`.
        var data = ""
        var event = ""
        var retry: Int?
    }
}
