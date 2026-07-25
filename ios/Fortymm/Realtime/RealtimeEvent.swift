import Foundation

/// The boundary for `GET /v1/stream`: a frame's `data` string in, a trusted
/// typed event out (`.claude/rules/parse-at-boundaries.md`).
///
/// The wire is one unnamed message stream with the kind *inside* `data` — there
/// is no `event:` field — so there is exactly one parser here, and adding a
/// kind later never needs a new listener:
///
/// ```
/// data: {"v":1,"kind":"dashboard.changed","ts":"2026-07-25T00:26:37.607498Z"}
/// ```
///
/// The envelope is **strict where a mistake would be silent and lenient where
/// strictness would be self-harm**:
///
/// - **`v` is strict.** A protocol bump means the fields no longer mean what
///   this build thinks they mean, so an unknown version is refused as its own
///   outcome rather than being half-read.
/// - **`kind` is lenient**, via the app's `LenientRawDecodable` idiom: a newer
///   server publishing a kind this build has never heard of decodes to
///   `.unknown` and is handled coarsely, rather than throwing.
///
/// Nothing here throws. A decode failure costs the one event; it must never
/// take the connection down with it, because a connection lost to a malformed
/// frame takes the dashboard's whole freshness mechanism with it.

/// The kinds the server publishes today (`app/realtime/events.py: EventKind`).
///
/// Both mean "refetch the dashboard". `resync` additionally means "you may have
/// missed events" — it arrives on every connect and after a server-side pub/sub
/// recovery — which is what lets a client recover without a replay log.
enum RealtimeEventKind: String, LenientRawDecodable {
    case dashboardChanged = "dashboard.changed"
    case resync
    /// A kind from a newer server. Not an error: degrade, don't reject.
    case unknown
}

/// One hint off the stream.
struct RealtimeEvent: Equatable, Decodable {
    let v: Int
    let kind: RealtimeEventKind
    /// Kept as a plain string, not a `Date`. Nothing reads it — a hint is
    /// idempotent and carries no ordering — so parsing it to an instant would
    /// let a harmless timestamp-format change on the server start dropping
    /// events (and it is the one field a stricter decode could fail on).
    let ts: String
}

/// Why a frame's payload could not become an event. An `Error` so it can be the
/// failure half of a `Result`; it is never thrown — the connection drops the
/// event and reads on.
enum RealtimeDecodeFailure: Error, Equatable {
    /// Not JSON, or not shaped like an envelope at all.
    case malformed
    /// A well-formed envelope from a protocol this build does not speak.
    case unsupportedVersion
}

/// The decode itself: pure, total, and non-throwing.
enum RealtimeEnvelope {
    /// The only protocol version this build understands.
    static let protocolVersion = 1

    /// Decode one SSE frame's `data` payload. Every input produces a result and
    /// none of them throw.
    static func decode(_ payload: String) -> Result<RealtimeEvent, RealtimeDecodeFailure> {
        let bytes = Data(payload.utf8)
        // Probe the version first, so "a v2 envelope" is distinguishable from
        // "not an envelope" — the two want different handling if this ever
        // grows any.
        if let probe = try? decoder.decode(VersionProbe.self, from: bytes),
           probe.v != protocolVersion {
            return .failure(.unsupportedVersion)
        }
        guard let event = try? decoder.decode(RealtimeEvent.self, from: bytes) else {
            return .failure(.malformed)
        }
        return .success(event)
    }

    /// A plain decoder on purpose: `APIClient`'s is configured with
    /// `.convertFromSnakeCase` and a date strategy, neither of which this
    /// three-field envelope wants — and one of which (the dictionary-key bug on
    /// iOS 17) is worth staying away from where it buys nothing.
    private static let decoder = JSONDecoder()

    private struct VersionProbe: Decodable {
        let v: Int
    }
}
