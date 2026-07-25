import { api } from '../client'
import { decodeRealtimeEvent, type RealtimeEvent } from './events'
import { nextFailureCount, reconnectDelayMs } from './reconnect'
import { readSseFrames } from './sse-frames'

/**
 * The live connection to `GET /v1/stream`: open it, read hints off it, and keep
 * it open across the drops and the server's own scheduled hang-ups.
 *
 * ## It goes through the typed client, not `fetch`
 *
 * `api.GET('/v1/stream', { parseAs: 'stream' })` hands back `response.body`
 * un-consumed, but only **after** every `onResponse` middleware in
 * `../client.ts` has run. That is the whole reason not to reach for `fetch`
 * here: a 401 on the stream then fires the existing global
 * `session_ended`/`session_merged` path for free, exactly as it does for every
 * other call in the app, instead of this one connection needing a private copy
 * of that rule. (`EventSource` would have been the same bypass with less
 * control — no request headers, no `AbortController`, no access to a non-200.)
 *
 * ## The shape of the loop
 *
 * Open → read frames → the stream ends → wait → open again, until closed. There
 * is nothing to subscribe to and nothing to ref-count: `/v1/stream` takes no
 * parameters and the topic is always the caller's own user, so navigation never
 * touches this and one connection per tab is the whole story.
 *
 * Two failure modes are treated as ordinary rather than exceptional, because
 * they are:
 *
 * - **A clean end of stream is not an error.** The server closes every stream at
 *   ~15 minutes on purpose, so re-authenticating and re-connecting *is* the
 *   design. The reconnect policy (`./reconnect`) reads that as a healthy
 *   connection and comes back promptly.
 * - **A frame we cannot read costs the EVENT, never the CONNECTION.** A
 *   malformed payload, or one from a protocol this build does not speak, is
 *   dropped and the loop reads on. Tearing the connection down over one bad
 *   frame would take the dashboard's entire freshness mechanism with it — and it
 *   would do so on exactly the deploy where a newer server started sending
 *   something new.
 */

export interface RealtimeConnectionOptions {
  /** Called once per decoded hint, in wire order. */
  onEvent: (event: RealtimeEvent) => void
  /**
   * Test seams. They exist so the reconnect behaviour can be driven without
   * fake timers: `vi.useFakeTimers()` alongside MSW and this suite's 5s
   * `asyncUtilTimeout` is a known flake generator here, and a test that has to
   * advance a clock to see a retry ends up asserting the clock.
   */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>
  random?: () => number
  now?: () => number
}

export interface RealtimeConnection {
  /** Abort the in-flight request and stop reconnecting. Idempotent. */
  close: () => void
  /** Resolves once the loop has exited. Never rejects. */
  readonly finished: Promise<void>
}

/**
 * Every connection this module has open.
 *
 * A module-level registry rather than a single slot, because React StrictMode
 * mounts the provider twice in dev and a "there is exactly one" invariant would
 * be false for the length of that second mount — and because
 * `closeRealtimeConnections` below has to be able to close *whatever is open*
 * from a callback that holds no reference to any of it.
 */
const open = new Set<RealtimeConnection>()

/** Open a connection and start reading. */
export function openRealtimeConnection(
  options: RealtimeConnectionOptions,
): RealtimeConnection {
  const controller = new AbortController()
  const connection: RealtimeConnection = {
    close: () => controller.abort(),
    finished: runLoop(controller.signal, options),
  }
  open.add(connection)
  void connection.finished.finally(() => open.delete(connection))
  return connection
}

/**
 * Close every open stream, synchronously.
 *
 * Called from the identity-change sequence **before** the query cache is
 * cleared (`../identity-change`) — by the deliberate sign-out as much as by the
 * session-ended 401 — and the ordering is load-bearing: `queryClient.clear()`
 * is synchronous while the redirect that follows it is not, so a stream left
 * reading during that gap can answer a hint by repopulating the cache that was
 * just emptied — with the departed user's data, in front of whoever signs in
 * next.
 */
export function closeRealtimeConnections(): void {
  for (const connection of open) connection.close()
}

/** The reconnect loop. Never rejects: every failure is a reconnect. */
async function runLoop(
  signal: AbortSignal,
  options: RealtimeConnectionOptions,
): Promise<void> {
  const sleep = options.sleep ?? sleepUnlessAborted
  const random = options.random ?? Math.random
  const now = options.now ?? Date.now

  /** Consecutive short-lived connections — see `nextFailureCount`. */
  let failures = 0
  /** The last `retry:` the server sent, kept ACROSS reconnects: a directive is
   * the server's standing preference, not a property of one connection, and a
   * client that forgot it on drop would back off from the default instead. */
  let retryDirectiveMs: number | null = null

  while (!signal.aborted) {
    const openedAt = now()
    try {
      for await (const frame of readSseFrames(await openStream(signal))) {
        // ⚠️ `frame.kind` (the WIRE: retry / message) is not `event.kind` (the
        // PAYLOAD: dashboard.changed / resync / unknown). Two different kinds,
        // three lines apart.
        if (frame.kind === 'retry') {
          retryDirectiveMs = frame.ms
          continue
        }
        const decoded = decodeRealtimeEvent(frame.data)
        if (decoded.ok) options.onEvent(decoded.event)
      }
    } catch {
      // A refusal (401/429/503), a network fault, or our own abort. All three
      // land here and all three are answered the same way — by the checks
      // below, which is why there is nothing to distinguish.
    }
    if (signal.aborted) return
    failures = nextFailureCount(failures, now() - openedAt)
    await sleep(reconnectDelayMs(failures, retryDirectiveMs, random), signal)
  }
}

/**
 * One connection's byte stream.
 *
 * `parseAs: 'stream'` is what keeps the body un-consumed; without it
 * openapi-fetch would `await response.json()` and hang on a stream that never
 * ends. A non-2xx has no `data`, and is thrown so the loop treats it as a failed
 * attempt — the *handling* of a session-ended 401 has already happened by then,
 * inside the client's response middleware.
 *
 * ## Why the body is piped rather than read directly
 *
 * `close()` has to actually stop the reader, and "abort the request and trust
 * the transport to error its body" is not a property every transport has.
 * A browser's `fetch` does it; MSW's Node interceptor — the thing every vitest
 * test in this repo talks to — hands the handler's stream straight through and
 * leaves a pending `read()` pending FOREVER on abort (measured: without this
 * pipe, closing a connection mid-read never resolves).
 *
 * Piping through an identity `TransformStream` with the same signal makes the
 * termination the *client's* own: on abort the pipe is aborted, the destination
 * errors, the read rejects, and the loop exits — whatever the transport
 * underneath decided to do. That matters beyond tests, because the ordering the
 * identity-change path depends on (`../identity-change`) is only worth anything
 * if closing is immediate.
 */
async function openStream(
  signal: AbortSignal,
): Promise<ReadableStream<Uint8Array>> {
  const { data, response } = await api.GET('/v1/stream', {
    headers: { Accept: 'text/event-stream' },
    parseAs: 'stream',
    signal,
  })
  if (!data) throw new Error(`/v1/stream refused with ${response.status}`)
  return data.pipeThrough(new TransformStream<Uint8Array, Uint8Array>(), {
    signal,
  })
}

/** `setTimeout`, but it gives up the moment the connection is closed — so a
 * tab that signs out mid-backoff does not hold a pending reconnect. */
function sleepUnlessAborted(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    signal.addEventListener('abort', done, { once: true })
  })
}
