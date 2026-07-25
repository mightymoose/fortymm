import { test, expect } from '@playwright/test'

import {
  acceptResult,
  createMatch,
  findUserId,
  guestFromContext,
  mintGuest,
  proposeResult,
} from '../support/match-api'
import { BrowserStream } from '../support/realtime-stream'

/**
 * The realtime dashboard hint, end to end through the real proxy.
 *
 * This is the only test in the arc that puts **nginx** between the write that
 * causes a hint and the browser that consumes it. The broker tests run against
 * fakeredis, the route tests drive the ASGI app in-process, and the web tests
 * answer `/v1/stream` with a stub — so all of them stay green against a proxy
 * that buffers the stream into oblivion. `location /api/` proxies with
 * `proxy_buffering` on and a 60s `proxy_read_timeout`; the dedicated
 * `location /api/v1/stream` block in `nginx/dev.conf` is what turns buffering
 * off and lifts the timeout. If that block is deleted or a new deployment's
 * proxy ignores `X-Accel-Buffering: no`, this spec is the thing that notices.
 *
 * Two properties make it capable of noticing, and both are easy to lose:
 *
 * 1. **It asserts the frame landed on an already-open connection.** Polling the
 *    dashboard until it looks right would pass with the stream completely dead
 *    — the page refetches on navigation and on reconnect anyway. So the
 *    assertion is on frames captured by a live `EventSource`, and on the
 *    connection generation that delivered them.
 * 2. **It bounds arrival latency.** A buffered stream is not a stream that
 *    loses frames; it is one that delivers them all at once when the connection
 *    ends. An open-ended `waitFor` would be satisfied by that. The real
 *    pipeline is sub-second (publish on commit → 50ms broker poll → 250ms
 *    coalesce window → flush), so the ceilings below are ~10x headroom over
 *    healthy and far under the 60s at which a buffering proxy would first
 *    disgorge anything.
 */

/** Ceiling on connect → first frame. The `retry:` directive and the `resync`
 * are written before the generator ever waits, so a live proxy delivers them
 * essentially at connect. */
const MAX_CONNECT_LATENCY_MS = 5_000

/** Ceiling on mutation → hint. Deliberately well under nginx's default 60s
 * `proxy_read_timeout` (the earliest a buffering proxy could flush) so a
 * buffering regression trips this rather than passing late. */
const MAX_HINT_LATENCY_MS = 5_000

test.describe('Realtime dashboard hints through nginx', () => {
  // Generous, because the *test timeout* is not what enforces promptness — the
  // latency assertions are. This only keeps a genuine failure reporting its own
  // message (a measured latency, or "no frame arrived") instead of a timeout.
  test.setTimeout(60_000)

  test('a dashboard.changed frame reaches an open browser stream seconds after an opponent accepts', async ({
    page,
    baseURL,
  }) => {
    expect(baseURL, 'baseURL must be set for the API seed').toBeTruthy()

    // Guest A is the browser's own session: `page.request` shares the context's
    // cookie jar, so the `EventSource` the page opens later authenticates as A
    // and the server scopes the stream to A's topic. Minted *before* the first
    // navigation so the app finds an existing session cookie rather than
    // racing us to mint a second one.
    const a = await guestFromContext(page.request)

    // Guest B is a separate session in its own cookie jar — the opponent whose
    // write, made entirely outside this browser, must reach A's open stream.
    const b = await mintGuest(baseURL!)

    // Seed *before* opening the stream, so the only hint that can arrive on it
    // is the one the acceptance causes. Rated and two-party on purpose: only
    // then does the proposal stay standing for the other side, which gives us a
    // single, precisely-timed mutation (B's acceptance → `finalize_match` →
    // a staged `dashboard.changed` for both participants) to measure against.
    const opponentId = await findUserId(a, b.username)
    const matchId = await createMatch(a, opponentId, 1, { rated: true })
    const resultId = await proposeResult(a, matchId, [
      { game_number: 1, side_1_points: 11, side_2_points: 5 },
    ])

    // The landing page is enough of a host for the connection and, unlike an
    // authenticated route, opens no stream of its own — so every frame recorded
    // here belongs to the connection this spec controls.
    await page.goto('/')
    const stream = await BrowserStream.open(page)

    // First proof, before any mutation: the connect-time `resync` crosses the
    // proxy promptly. A buffering proxy holds this frame too, so this alone
    // already fails on a buffered stream.
    const resync = await stream.waitForHint('resync')
    expect(
      resync.latencyMs,
      'the connect-time resync must reach the browser promptly — a late or ' +
        'missing one means the proxy is buffering the stream',
    ).toBeLessThan(MAX_CONNECT_LATENCY_MS)

    // Now the real thing: a mutation driven wholly outside this browser, timed
    // from the instant it is issued.
    await stream.mark()
    await acceptResult(b, matchId, resultId)

    const hint = await stream.waitForHint('dashboard.changed')
    expect(
      hint.latencyMs,
      'the hint must reach the already-open stream within seconds — a larger ' +
        'number means frames are being held somewhere between the publisher ' +
        'and the browser',
    ).toBeLessThan(MAX_HINT_LATENCY_MS)

    // …and it arrived on the connection that was *already open* when B wrote,
    // not on a reconnect. This is what separates a live push from the client
    // simply re-establishing and re-reading.
    expect(
      hint.connection,
      'the hint must arrive on the first connection, not after a reconnect',
    ).toBe(1)

    const snapshot = await stream.snapshot()
    expect(
      snapshot.connections,
      'the stream must have stayed open throughout — a reconnect means the ' +
        'proxy cut it',
    ).toBe(1)

    await stream.close()
    await b.ctx.dispose()
  })
})
