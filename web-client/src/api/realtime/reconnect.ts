/**
 * The reconnect policy for `GET /v1/stream`: how long to wait before opening the
 * next connection, and when to forget that the last few went badly.
 *
 * It is **two pure functions**, deliberately — the same convention
 * `scheduleRefetchInterval` and `previewPollInterval` follow. A retry policy is
 * the kind of thing that is trivially wrong (a hot loop against a 503'ing pod, a
 * thundering herd of every open tab reconnecting on the same tick) and
 * miserable to test through timers, so the arithmetic is lifted out of the
 * connection entirely and table-tested against `./reconnect.test.ts`. The
 * connection's job is then only to *call* these in the right order.
 *
 * ## Full jitter, not "backoff plus a bit of noise"
 *
 * The delay is `random() * ceiling`, i.e. uniform over the WHOLE interval, not
 * `ceiling ± 10%`. Every tab a user has open — and every tab of every user, when
 * a pod restarts — is disconnected by the same event at the same instant. With a
 * narrow jitter band they all come back inside the same narrow window and hit the
 * pod that just came up with a synchronized wave. Full jitter spreads them evenly
 * across the interval, which is the point of it.
 *
 * ## The server's `retry:` is the base, and it is not overruled
 *
 * The stream's first frame is a jittered `retry:` directive, and it is what the
 * *server* wants its clients' reconnect cadence to be. So it becomes the base,
 * and `MAX_RECONNECT_DELAY_MS` bounds only the **escalation** on top of it —
 * a directive longer than the cap is honoured rather than clamped down to it.
 * (That also gives a test harness a way to park a stubbed stream: answer with a
 * very long `retry:` and the client stands down instead of reconnect-looping.)
 */

/** The base to use before the server has told us its own — matching the middle
 * of the 3–8s band `/v1/stream` jitters its directive across. */
export const DEFAULT_RECONNECT_BASE_MS = 3_000

/** Floor on the base, whatever the server says. A `retry: 0` from a confused (or
 * hostile) server must not turn the client into a request loop. */
export const MIN_RECONNECT_BASE_MS = 500

/** Ceiling on the ESCALATION (see the module note): a sustained outage settles
 * at about a minute between attempts rather than backing off to never. */
export const MAX_RECONNECT_DELAY_MS = 60_000

/**
 * How long a connection has to have lasted to count as healthy.
 *
 * Comfortably longer than a connect + first frames, and far shorter than the
 * server's ~15 minute lifetime — so the stream closing on its own schedule
 * always reads as "that one was fine", while a stream that dies on arrival
 * always reads as a failure.
 */
export const STABLE_CONNECTION_MS = 30_000

/**
 * The consecutive-failure count after a connection that lasted `openForMs`.
 *
 * **Duration decides, not the reason.** The server ends every stream cleanly at
 * ~15 minutes by design, so an orderly end-of-stream is the normal case and must
 * not escalate anything — but "it ended cleanly" cannot be the test, because a
 * server that closes the instant it accepts would then be reconnected against as
 * fast as the network allows, forever. A connection that stayed up is forgiven;
 * one that did not is counted, however politely it ended.
 */
export function nextFailureCount(failures: number, openForMs: number): number {
  return openForMs >= STABLE_CONNECTION_MS ? 0 : failures + 1
}

/**
 * How long to wait before the next connection attempt.
 *
 * `failures` is the number of *consecutive* short-lived connections, the one
 * that just ended included — so `0` means the last connection was healthy and
 * the client should come back promptly.
 *
 * `retryDirectiveMs` is the last `retry:` the server sent, or `null` if it has
 * never got that far.
 */
export function reconnectDelayMs(
  failures: number,
  retryDirectiveMs: number | null,
  random: () => number = Math.random,
): number {
  const base = Math.max(
    MIN_RECONNECT_BASE_MS,
    retryDirectiveMs ?? DEFAULT_RECONNECT_BASE_MS,
  )
  // 0 and 1 failures both sit at the base: the first retry after a healthy
  // connection and the first retry after a single blip should feel the same to
  // a user, and doubling on the very first failure would only make a one-off
  // network hiccup cost twice as long as the server asked for.
  const escalated = base * 2 ** Math.max(0, failures - 1)
  const ceiling = Math.max(base, Math.min(MAX_RECONNECT_DELAY_MS, escalated))
  return Math.floor(random() * ceiling)
}
