import { http, HttpResponse } from 'msw'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { server } from '@/mocks/server'
import { openRealtimeConnection, closeRealtimeConnections } from './connection'
import type { RealtimeEvent } from './events'
import { SSE_CONTENT_TYPE } from '@/mocks/realtime-stream'

/**
 * The reconnect loop, driven end to end over a real (MSW-served) byte stream.
 *
 * **No fake timers anywhere.** The connection takes `sleep`, `random` and `now`
 * as options precisely so this file never has to advance a clock: fake timers
 * plus MSW plus this suite's 5s `asyncUtilTimeout` is a known way to produce an
 * opaque red here, and a test that has to tick a clock to see a retry ends up
 * asserting the clock instead of the policy. The delay ARITHMETIC is table
 * tested in `./reconnect.test.ts`; what is asserted here is that the loop calls
 * it, honours what it returns, and comes back.
 */

const HINT = '{"v":1,"kind":"dashboard.changed","ts":"2026-07-24T18:02:11Z"}'
const RESYNC = '{"v":1,"kind":"resync","ts":"2026-07-24T18:02:11Z"}'

/** One server-side connection: a stream the test writes into by hand. */
class Wire {
  private controller!: ReadableStreamDefaultController<Uint8Array>
  readonly body = new ReadableStream<Uint8Array>({
    start: (controller) => {
      this.controller = controller
    },
  })

  send(text: string): void {
    this.controller.enqueue(new TextEncoder().encode(text))
  }

  /** Close it the way the real server does at ~15 minutes: cleanly. */
  end(): void {
    this.controller.close()
  }
}

/**
 * Serve `/v1/stream`, handing back a fresh `Wire` per connection.
 *
 * The array is the assertion surface for "did it reconnect?" — a second entry
 * means a second request reached the server, which no amount of client-side
 * bookkeeping can fake.
 */
function serveStream(): Wire[] {
  const wires: Wire[] = []
  server.use(
    http.get('*/v1/stream', () => {
      const wire = new Wire()
      wires.push(wire)
      return new HttpResponse(wire.body, {
        headers: { 'Content-Type': SSE_CONTENT_TYPE },
      })
    }),
  )
  return wires
}

/** A `sleep` the test resumes by hand, so a scheduled reconnect is observable
 * *before* it happens rather than inferred after it. */
function gatedSleep() {
  const calls: number[] = []
  let release: (() => void) | null = null
  return {
    calls,
    sleep: (ms: number) => {
      calls.push(ms)
      return new Promise<void>((resolve) => {
        release = resolve
      })
    },
    resume: () => {
      const go = release
      release = null
      go?.()
    },
  }
}

afterEach(() => closeRealtimeConnections())

describe('openRealtimeConnection', () => {
  it('decodes the hints the server pushes, in order', async () => {
    const wires = serveStream()
    const events: RealtimeEvent[] = []
    const connection = openRealtimeConnection({
      onEvent: (event) => events.push(event),
    })

    await vi.waitFor(() => expect(wires).toHaveLength(1))
    wires[0].send('retry: 5000\n\n')
    wires[0].send(`data: ${RESYNC}\n\n`)
    wires[0].send(`data: ${HINT}\n\n`)

    await vi.waitFor(() => expect(events).toHaveLength(2))
    expect(events.map((e) => e.kind)).toEqual(['resync', 'dashboard.changed'])

    connection.close()
    await connection.finished
  })

  // The whole reason `decodeRealtimeEvent` is total. A newer server that starts
  // publishing something this build cannot read must cost the client that one
  // event — not the connection, and so not the dashboard's freshness for the
  // rest of the session.
  it('drops an unreadable frame without dropping the connection', async () => {
    const wires = serveStream()
    const events: RealtimeEvent[] = []
    const gate = gatedSleep()
    const connection = openRealtimeConnection({
      onEvent: (event) => events.push(event),
      sleep: gate.sleep,
    })

    await vi.waitFor(() => expect(wires).toHaveLength(1))
    wires[0].send('data: not json at all\n\n')
    wires[0].send('data: {"v":99,"kind":"dashboard.changed","ts":"x"}\n\n')
    wires[0].send(`data: ${HINT}\n\n`)

    await vi.waitFor(() => expect(events).toHaveLength(1))
    expect(events[0].kind).toBe('dashboard.changed')
    // Still the same connection: nothing was torn down and nothing was retried.
    expect(wires).toHaveLength(1)
    expect(gate.calls).toEqual([])

    connection.close()
    await connection.finished
  })

  it('reconnects after the stream ends, waiting the delay the server asked for', async () => {
    const wires = serveStream()
    const events: RealtimeEvent[] = []
    const gate = gatedSleep()
    const connection = openRealtimeConnection({
      onEvent: (event) => events.push(event),
      sleep: gate.sleep,
      random: () => 0.5,
      // A frozen clock: the connection lasted 0ms, so it counts as one failure
      // and the delay is drawn from the base — the `retry: 5000` below.
      now: () => 0,
    })

    await vi.waitFor(() => expect(wires).toHaveLength(1))
    wires[0].send('retry: 5000\n\n')
    wires[0].send(`data: ${RESYNC}\n\n`)
    await vi.waitFor(() => expect(events).toHaveLength(1))

    // The server hangs up, as it does on every stream at ~15 minutes.
    wires[0].end()

    // It waits — half of the 5s the server asked for, `random()` being 0.5.
    // That the number is 2500 and not 1500 is the assertion: the directive was
    // read off the wire and used, rather than the built-in 3s default.
    await vi.waitFor(() => expect(gate.calls).toEqual([2500]))
    expect(wires).toHaveLength(1)

    gate.resume()

    // …and comes back, on a second connection the server sees.
    await vi.waitFor(() => expect(wires).toHaveLength(2))
    // The server opens every stream with a resync, and the client applies it —
    // which is how a gap during the disconnection self-heals.
    wires[1].send(`data: ${RESYNC}\n\n`)
    await vi.waitFor(() => expect(events).toHaveLength(2))
    expect(events[1].kind).toBe('resync')

    connection.close()
    await connection.finished
  })

  it('backs off from a refusal, using the default base before any directive', async () => {
    server.use(
      http.get('*/v1/stream', () =>
        HttpResponse.json({ detail: 'no realtime backend' }, { status: 503 }),
      ),
    )
    const gate = gatedSleep()
    const connection = openRealtimeConnection({
      onEvent: () => {},
      sleep: gate.sleep,
      random: () => 0.5,
      now: () => 0,
    })

    // 3000 (the default base) × 0.5 — the server never got as far as a `retry:`.
    await vi.waitFor(() => expect(gate.calls).toEqual([1500]))

    connection.close()
    gate.resume()
    await connection.finished
  })

  it('stops for good once closed, mid-backoff', async () => {
    const wires = serveStream()
    const gate = gatedSleep()
    const connection = openRealtimeConnection({
      onEvent: () => {},
      sleep: gate.sleep,
      now: () => 0,
    })

    await vi.waitFor(() => expect(wires).toHaveLength(1))
    wires[0].end()
    await vi.waitFor(() => expect(gate.calls).toHaveLength(1))

    connection.close()
    gate.resume()
    await connection.finished

    // The reconnect that was pending is abandoned rather than fired.
    expect(wires).toHaveLength(1)
  })

  // `closeRealtimeConnections` is what the identity-change sequence calls (the
  // sign-out and the session-ended 401 alike), from a callback that holds no
  // reference to any connection.
  it('closes every open connection from the module-level handle', async () => {
    const wires = serveStream()
    const one = openRealtimeConnection({ onEvent: () => {} })
    const two = openRealtimeConnection({ onEvent: () => {} })

    await vi.waitFor(() => expect(wires).toHaveLength(2))
    closeRealtimeConnections()

    await Promise.all([one.finished, two.finished])
    expect(wires).toHaveLength(2)
  })
})
