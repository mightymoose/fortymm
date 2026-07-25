import { expect, Page } from '@playwright/test'

/**
 * Composed-stack helper for observing `GET /v1/stream` **from inside the
 * browser**, over the real proxy.
 *
 * Everything else that covers the realtime feature runs in-process: the broker
 * tests use fakeredis, the route tests drive the ASGI app directly, the web
 * tests answer the stream with a stub. None of them puts nginx between the
 * publisher and the consumer, and nginx is where a Server-Sent-Events feature
 * dies in production — `location /api/` proxies with buffering ON and a 60s
 * `proxy_read_timeout`, which would hold every frame in an nginx buffer and
 * then cut the connection. `nginx/dev.conf` therefore carries a dedicated
 * `location /api/v1/stream` with `proxy_buffering off` and a long read timeout.
 * If that block regresses, every in-process test stays green.
 *
 * So the recorder deliberately uses the browser's own `EventSource` on the real
 * `/api/v1/stream` URL, driven through `page.evaluate`: same origin, same
 * cookie jar, same proxy hop a signed-in user's tab takes. (`EventSource` is a
 * browser global — it does not exist in Node or jsdom, which is exactly why no
 * other layer of the test suite can make this observation.)
 *
 * It records **when** each frame arrived, not merely that one did. That is the
 * whole point: a buffering proxy still delivers every frame eventually (at
 * connection close), so only an assertion on *arrival latency against an
 * already-open connection* can tell a live stream from a buffered one.
 */

/** The URL the browser opens — the proxied path, not the api container's. */
const STREAM_URL = '/api/v1/stream'

/** Where the page-side recorder parks its state. */
const HANDLE = '__fortymmRealtimeStream'

/** One `data:` frame as the browser received it. */
export interface StreamFrame {
  /** `kind` off the JSON envelope: `resync` or `dashboard.changed`. */
  readonly kind: string
  /** Arrival on the page's monotonic clock (`performance.now()`). */
  readonly atMs: number
  /** Which `EventSource` connection delivered it — 1 is the first. A frame on
   * connection 2+ arrived after a reconnect, i.e. NOT on the connection that
   * was already open when the mutation happened. */
  readonly connection: number
}

/** A frame plus how long after the preceding `mark()` it landed. */
export interface TimedFrame extends StreamFrame {
  readonly latencyMs: number
}

/** Everything the page-side recorder knows, at one instant. */
export interface StreamSnapshot {
  readonly frames: readonly StreamFrame[]
  /** Successful `open` events so far. Stays 1 for a healthy connection; more
   * means the stream was cut and `EventSource` reconnected. */
  readonly connections: number
  /** `error` events so far (a cut or refused connection). */
  readonly errors: number
}

/**
 * A live `EventSource` held open by the page under test, with every frame it
 * receives timestamped.
 *
 * Usage is: {@link open} → {@link waitForHint} the connect-time `resync` →
 * {@link mark} → drive a mutation elsewhere → {@link waitForHint} the
 * `dashboard.changed` it causes, and assert on the returned `latencyMs`.
 */
export class BrowserStream {
  private constructor(private readonly page: Page) {}

  /**
   * Open the stream in the page and start recording. The page must already be
   * on the app's origin and carry a `session` cookie — `EventSource` sends the
   * jar's cookies, and the route resolves the topic from that cookie alone.
   *
   * The mark is set here, so the very first `waitForHint('resync')` measures
   * time-to-first-frame from `new EventSource(...)`.
   */
  static async open(page: Page): Promise<BrowserStream> {
    await page.evaluate(
      ([url, handle]) => {
        const frames: {
          kind: string
          atMs: number
          connection: number
        }[] = []
        const recording = {
          frames,
          connections: 0,
          errors: 0,
          markedAtMs: performance.now(),
        }
        const source = new EventSource(url)
        source.addEventListener('open', () => {
          recording.connections += 1
        })
        source.addEventListener('error', () => {
          recording.errors += 1
        })
        // One unnamed message stream — the server sends no `event:` field, so
        // the kind is read out of the JSON payload (see `app/realtime/events`).
        source.addEventListener('message', (event) => {
          const payload = JSON.parse((event as MessageEvent<string>).data) as {
            kind?: unknown
          }
          frames.push({
            kind: String(payload.kind),
            atMs: performance.now(),
            connection: recording.connections,
          })
        })
        Object.assign(window, { [handle]: { recording, source } })
      },
      [STREAM_URL, HANDLE] as const,
    )
    return new BrowserStream(page)
  }

  /**
   * Start the clock for the next {@link waitForHint}.
   *
   * Call it immediately *before* triggering the mutation, so the measured
   * latency spans exactly "mutation issued → frame on the wire in the browser"
   * and cannot be satisfied by a frame that predates the mutation.
   */
  async mark(): Promise<void> {
    await this.page.evaluate((handle) => {
      const state = (window as unknown as Record<string, StreamState>)[handle]
      state.recording.markedAtMs = performance.now()
    }, HANDLE)
  }

  /**
   * Wait for the first frame of `kind` that arrived **after** the last
   * {@link mark}, and return it with its latency.
   *
   * `timeoutMs` is a generous ceiling that only decides *how the test fails*: a
   * frame that never comes fails here with "no … frame", a frame that comes
   * late fails on the caller's latency assertion with the number. Promptness is
   * the caller's assertion, never this timeout.
   */
  async waitForHint(kind: string, timeoutMs = 10_000): Promise<TimedFrame> {
    const find = () => this.findHint(kind)
    await expect
      .poll(find, {
        timeout: timeoutMs,
        message:
          `no "${kind}" frame reached the browser within ${timeoutMs}ms — ` +
          'the stream never opened, or the proxy is holding frames',
      })
      .not.toBeNull()
    const frame = await find()
    if (frame === null) throw new Error(`"${kind}" frame vanished between polls`)
    return frame
  }

  /** Frames and connection tallies as of now, for assertions about the
   * connection itself (that it never dropped, that nothing else arrived). */
  snapshot(): Promise<StreamSnapshot> {
    return this.page.evaluate((handle) => {
      const { recording } = (window as unknown as Record<string, StreamState>)[
        handle
      ]
      return {
        frames: recording.frames,
        connections: recording.connections,
        errors: recording.errors,
      }
    }, HANDLE)
  }

  /** Close the connection, freeing the caller's slot against the per-user
   * connection cap (`REALTIME_MAX_CONNECTIONS_PER_USER`). */
  async close(): Promise<void> {
    await this.page.evaluate((handle) => {
      const state = (window as unknown as Record<string, StreamState>)[handle]
      state?.source.close()
    }, HANDLE)
  }

  private findHint(kind: string): Promise<TimedFrame | null> {
    return this.page.evaluate(
      ([wanted, handle]) => {
        const { recording } = (
          window as unknown as Record<string, StreamState>
        )[handle]
        const frame = recording.frames.find(
          (candidate) =>
            candidate.kind === wanted && candidate.atMs >= recording.markedAtMs,
        )
        return frame === undefined
          ? null
          : { ...frame, latencyMs: frame.atMs - recording.markedAtMs }
      },
      [kind, HANDLE] as const,
    )
  }
}

/** Shape of the page-side state, for the `window` casts above. */
interface StreamState {
  recording: {
    frames: StreamFrame[]
    connections: number
    errors: number
    markedAtMs: number
  }
  source: { close: () => void }
}
