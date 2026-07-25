import Foundation

/// The reconnect policy for `GET /v1/stream`: how long to wait before opening
/// the next connection, and when to forget that the last few went badly.
///
/// Two pure functions, deliberately. A retry policy is trivially wrong (a hot
/// loop against a 503ing pod, a thundering herd of every device reconnecting on
/// the same tick) and miserable to test through timers, so the arithmetic is
/// lifted out of the connection entirely; the connection's job is only to
/// *call* these in the right order. Mirrors
/// `web-client/src/api/realtime/reconnect.ts`.
///
/// ## Full jitter, not "backoff plus a bit of noise"
///
/// The delay is `random() * ceiling` — uniform over the WHOLE interval, not
/// `ceiling ± 10%`. Every client is disconnected by the same event at the same
/// instant when a pod restarts; with a narrow jitter band they all come back
/// inside the same narrow window and hit the pod that just came up with a
/// synchronized wave.
///
/// ## The server's `retry:` is the base, and it is not overruled
///
/// The stream's first frame is a jittered `retry:` directive, and it is what
/// the *server* wants its clients' reconnect cadence to be. So it becomes the
/// base, and `maximumDelayMilliseconds` bounds only the **escalation** on top
/// of it — a directive longer than the cap is honoured rather than clamped down
/// to it.
enum RealtimeReconnect {
    /// The base to use before the server has told us its own — the middle of
    /// the 3–8s band `/v1/stream` jitters its directive across.
    static let defaultBaseMilliseconds = 3_000

    /// Floor on the base, whatever the server says. A `retry: 0` from a
    /// confused (or hostile) server must not turn the app into a request loop.
    static let minimumBaseMilliseconds = 500

    /// Ceiling on the ESCALATION (see the note above): a sustained outage
    /// settles at about a minute between attempts rather than backing off to
    /// never.
    static let maximumDelayMilliseconds = 60_000

    /// How long a connection has to have lasted to count as healthy.
    ///
    /// Comfortably longer than a connect plus first frames, and far shorter
    /// than the server's ~15 minute lifetime — so the stream closing on its own
    /// schedule always reads as "that one was fine", while a stream that dies
    /// on arrival always reads as a failure.
    static let stableConnectionMilliseconds = 30_000

    /// The consecutive-failure count after a connection that lasted
    /// `openForMilliseconds`.
    ///
    /// **Duration decides, not the reason.** The server ends every stream
    /// cleanly at ~15 minutes by design, so an orderly end-of-stream is the
    /// normal case and must not escalate anything — but "it ended cleanly"
    /// cannot be the test, because a server that closes the instant it accepts
    /// would then be reconnected against as fast as the network allows,
    /// forever. A connection that stayed up is forgiven; one that did not is
    /// counted, however politely it ended.
    static func nextFailureCount(_ failures: Int, openForMilliseconds: Int) -> Int {
        openForMilliseconds >= stableConnectionMilliseconds ? 0 : failures + 1
    }

    /// How long to wait before the next connection attempt.
    ///
    /// `failures` is the number of *consecutive* short-lived connections, the
    /// one that just ended included — so `0` means the last connection was
    /// healthy and the client should come back promptly. `retryDirective` is
    /// the last `retry:` the server sent, or `nil` if it has never got that far.
    static func delayMilliseconds(
        failures: Int,
        retryDirective: Int?,
        random: () -> Double = { Double.random(in: 0..<1) }
    ) -> Int {
        let base = max(minimumBaseMilliseconds, retryDirective ?? defaultBaseMilliseconds)
        // 0 and 1 failures both sit at the base: the first retry after a healthy
        // connection and the first retry after a single blip should feel the
        // same, and doubling on the very first failure would make a one-off
        // network hiccup cost twice as long as the server asked for.
        // Computed in `Double` so a long outage's exponent overflows to
        // infinity (which `min` clamps) rather than trapping.
        let escalated = Double(base) * pow(2, Double(max(0, failures - 1)))
        let ceiling = max(Double(base), min(Double(maximumDelayMilliseconds), escalated))
        return Int(random() * ceiling)
    }
}
