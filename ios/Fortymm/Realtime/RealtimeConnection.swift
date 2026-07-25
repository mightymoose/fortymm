import Foundation

/// The live connection to `GET /v1/stream`: open it, read hints off it, and
/// keep it open across drops and the server's own scheduled hang-ups.
///
/// ## It goes through `APIClient`, not a private URLSession
///
/// `ios/CLAUDE.md` says all HTTP goes through `APIClient`, and here that is
/// load-bearing rather than tidy: the app turns URLSession's cookie storage off
/// and sets the session `Cookie` header by hand from the Keychain, so a stream
/// opened on any other session would be **anonymous and refused with a 401**.
/// `APIClient.openStream` builds the request through the same path every other
/// call uses, which also gets this connection the structured `session_merged`
/// 401 and the API's own error messages for free.
///
/// ## The shape of the loop
///
/// Open → read frames → the stream ends → wait → open again, until the task is
/// cancelled. There is nothing to subscribe to and nothing to ref-count:
/// `/v1/stream` takes no parameters and the topic is always the caller's own
/// user, so one connection per app is the whole story.
///
/// Two failure modes are treated as ordinary rather than exceptional, because
/// they are:
///
/// - **A clean end of stream is not an error.** The server closes every stream
///   at ~15 minutes on purpose, so reconnecting *is* the design. The policy in
///   `RealtimeReconnect` reads a long-lived connection as healthy and comes back
///   promptly instead of escalating a backoff.
/// - **A frame we cannot read costs the EVENT, never the CONNECTION.** A
///   malformed payload, or a kind from a protocol this build does not speak, is
///   dropped and the loop reads on. Tearing the connection down over one bad
///   frame would take the dashboard's whole freshness mechanism with it — on
///   exactly the deploy where a newer server started sending something new.
///
/// Unlike the browser's `EventSource`, nothing honours the server's `retry:`
/// for us, so this loop does it itself: the directive is remembered **across**
/// reconnects, because it is the server's standing preference rather than a
/// property of one connection.
struct RealtimeConnection {
    /// The authenticated client the stream is opened on.
    var client: APIClient = .shared

    /// The stream endpoint. A constant in practice; a property so a harness can
    /// point at a stand-in.
    var path: String = "/v1/stream"

    /// Every frame read off the wire, before decoding — a diagnostics seam (it
    /// is how the `retry:` directive and the keepalive-free frame sequence can
    /// be observed at all, since neither reaches `onEvent`).
    var onFrame: ((SSEFrame) -> Void)?

    /// Read hints until the surrounding `Task` is cancelled.
    ///
    /// Never throws: every failure — a refusal, a network fault, an ordinary
    /// end of stream — is answered by reconnecting. Returns only on
    /// cancellation, which is the caller's own doing.
    ///
    /// `onEvent` is called on whatever executor the loop is running on, once
    /// per decoded hint, in wire order.
    func run(onEvent: (RealtimeEvent) -> Void) async {
        let clock = ContinuousClock()
        /// Consecutive short-lived connections — see `nextFailureCount`.
        var failures = 0
        /// The last `retry:` the server sent, kept across reconnects.
        var retryDirective: Int?

        while !Task.isCancelled {
            let openedAt = clock.now
            do {
                let bytes = try await client.openStream(path)
                var parser = SSEFrameParser()
                // Byte by byte: the parser's whole job is that a chunk boundary
                // is not a frame boundary, and the wire is a few hundred bytes a
                // minute, so the simplest feed is also fast enough.
                for try await byte in bytes {
                    for frame in parser.consume(CollectionOfOne(byte)) {
                        onFrame?(frame)
                        // ⚠️ `SSEFrame` (the WIRE: retry / message) is not
                        // `RealtimeEventKind` (the PAYLOAD: dashboard.changed /
                        // resync / unknown). Two different kinds, three lines
                        // apart.
                        switch frame {
                        case let .retry(milliseconds):
                            retryDirective = milliseconds
                        case let .message(_, data):
                            if case let .success(event) = RealtimeEnvelope.decode(data) {
                                onEvent(event)
                            }
                        }
                    }
                }
            } catch {
                // A refusal (401/429/503), a network fault, or our own
                // cancellation. All three land here and all three are answered
                // the same way — by the checks below, which is why there is
                // nothing here to distinguish.
            }
            if Task.isCancelled { return }

            failures = RealtimeReconnect.nextFailureCount(
                failures, openForMilliseconds: (clock.now - openedAt).wholeMilliseconds
            )
            let delay = RealtimeReconnect.delayMilliseconds(
                failures: failures, retryDirective: retryDirective
            )
            do {
                try await Task.sleep(for: .milliseconds(delay))
            } catch {
                return // cancelled mid-backoff
            }
        }
    }
}

private extension Duration {
    /// Whole elapsed milliseconds — enough resolution for "did this connection
    /// stay up", and an `Int` so the policy stays integer arithmetic.
    var wholeMilliseconds: Int {
        let (seconds, attoseconds) = components
        return Int(seconds * 1_000 + attoseconds / 1_000_000_000_000_000)
    }
}
