import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { http, HttpResponse } from 'msw'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { useDashboard } from '@/api/dashboard'
import { closeRealtimeConnections } from '@/api/realtime/connection'
import { SSE_CONTENT_TYPE } from '@/mocks/realtime-stream'
import { server } from '@/mocks/server'
import { unratedDashboardRating } from '@/test/factories'
import type { components } from '@/api/schema'
import { RealtimeProvider } from './realtime-provider'

/**
 * The claim the whole slice exists for: a hint the server pushes makes the
 * dashboard on screen refetch — **no navigation, no reload**.
 *
 * That is the gap this closes. The dashboard had `staleTime: 30_000` and
 * `refetchOnWindowFocus: false`, so a player sitting on it while their opponent
 * posted a result watched a stale "needs your attention" row until they
 * navigated away and back.
 *
 * The other half of the claim is the *cost*: one page load must buy exactly one
 * read of `/v1/dashboard`. The server opens every stream with a `resync`, so
 * applying that one indiscriminately doubled every load
 * (`api/realtime/connect-resync.ts`). The tests below hold both ends at once —
 * the connect-time resync costs nothing, and every later one still refetches,
 * because that is how a gap self-heals.
 */

type DashboardResponse = components['schemas']['DashboardResponse']

function dashboardWith(attentionTotal: number): DashboardResponse {
  return {
    attention: [],
    attention_total_count: attentionTotal,
    waiting_count: 0,
    // Rating is irrelevant to the resync behaviour under test; the block is
    // always present now, so stand in a valid non-RATED shape.
    rating: unratedDashboardRating(),
    completed_match_count: 0,
    recent_results: [],
    tournaments: [],
  }
}

const RESYNC_FRAME = 'data: {"v":1,"kind":"resync","ts":"2026-07-24T18:02:11Z"}\n\n'
const CHANGED_FRAME =
  'data: {"v":1,"kind":"dashboard.changed","ts":"2026-07-24T18:02:11Z"}\n\n'

/**
 * One server-side connection: a stream the test writes into by hand.
 *
 * A wire *per connection* rather than one shared body, because the reconnect
 * case below has to be able to hang up on the client and answer the next
 * request with a fresh stream — exactly what the real server's ~15-minute
 * recycle does.
 */
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

  /** End it the way the real server does at ~15 minutes: cleanly. */
  end(): void {
    this.controller.close()
  }
}

/** A hand-driven `/v1/stream`, plus a `/v1/dashboard` whose answer the test
 * changes between reads — so a refetch is visible as a different number. */
function serve() {
  const state = { attentionTotal: 1, reads: 0 }
  const wires: Wire[] = []

  server.use(
    http.get('*/v1/stream', () => {
      const wire = new Wire()
      wires.push(wire)
      return new HttpResponse(wire.body, {
        headers: { 'Content-Type': SSE_CONTENT_TYPE },
      })
    }),
    http.get('*/v1/dashboard', () => {
      state.reads += 1
      return HttpResponse.json(dashboardWith(state.attentionTotal))
    }),
  )

  return {
    state,
    wires,
    /** The nth connection the client opened, once it has arrived. */
    connection: async (n = 1) => {
      await vi.waitFor(() => expect(wires.length).toBeGreaterThanOrEqual(n), {
        timeout: 3000,
      })
      return wires[n - 1]
    },
    /** What the server sends on connect, and again after a pub/sub recovery. */
    pushResync: (wire: Wire) => wire.send(RESYNC_FRAME),
    /** What the server publishes after, say, an opponent posts a result. */
    pushDashboardChanged: (wire: Wire) => {
      state.attentionTotal += 1
      wire.send(CHANGED_FRAME)
    },
    /** Something moved while the client was not listening. Nothing is pushed —
     * the client only ever learns about it from a later `resync`. */
    changeWhileDisconnected: () => {
      state.attentionTotal += 1
    },
  }
}

/**
 * Long enough for a refetch to have happened if one was going to.
 *
 * The dashboard read is served in-process by MSW and lands within a tick or
 * two, so this is orders of magnitude more room than it needs — and the
 * assertions that follow a `settle()` are backed up by a later read count, so a
 * refetch that somehow outran this window is still caught.
 */
const settle = () => new Promise((resolve) => setTimeout(resolve, 100))

function client() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 30_000 } },
  })
}

/** Renders the one number the dashboard query carries, so a refetch is
 * observable in the DOM rather than in a spy. */
function AttentionCount() {
  const dashboard = useDashboard()
  return <p data-testid="count">{dashboard.data?.attention_total_count ?? '…'}</p>
}

function renderProvider(queryClient: QueryClient) {
  return render(
    <QueryClientProvider client={queryClient}>
      <RealtimeProvider>
        <AttentionCount />
      </RealtimeProvider>
    </QueryClientProvider>,
  )
}

afterEach(() => closeRealtimeConnections())

describe('RealtimeProvider', () => {
  it('refetches the dashboard when the server pushes a hint', async () => {
    const wire = serve()
    const hrefBefore = window.location.href

    renderProvider(client())

    expect(await screen.findByText('1')).toBeInTheDocument()
    expect(wire.state.reads).toBe(1)

    // Also the "first event of the run" case for `dashboard.changed`: nothing
    // precedes it, and it must still refetch.
    wire.pushDashboardChanged(await wire.connection())

    // The rendered number moves on its own. `staleTime: 30_000` is left at the
    // app's real value on purpose: an invalidation has to beat it, which is
    // exactly what a cache-freshness window would not do.
    expect(await screen.findByText('2')).toBeInTheDocument()
    expect(wire.state.reads).toBe(2)

    // Nothing navigated and nothing reloaded — the same document, the same URL.
    expect(window.location.href).toBe(hrefBefore)
  })

  // The bug QA found: every `/dashboard` load produced two reads — one on load,
  // one the instant the stream connected — and every ~15-minute recycle bought
  // another, per connected user.
  it('costs one dashboard read per page load, connect-time resync included', async () => {
    const wire = serve()

    renderProvider(client())

    expect(await screen.findByText('1')).toBeInTheDocument()
    expect(wire.state.reads).toBe(1)

    const stream = await wire.connection()
    wire.pushResync(stream)
    await settle()

    expect(wire.state.reads).toBe(1)

    // …and the harness would have seen a read had one happened: the same wire,
    // one frame later, moves the number. So the `1` above is a suppressed
    // refetch, not a stream nobody was listening to. (A `dashboard.changed`
    // after the connect resync — the "not the first event" half of "always
    // refetches".)
    wire.pushDashboardChanged(stream)
    expect(await screen.findByText('2')).toBeInTheDocument()
    expect(wire.state.reads).toBe(2)
  })

  // Only the FIRST event is redundant. A second `resync` on the same
  // connection is the server recovering its pub/sub subscription: it is
  // announcing that events may have been dropped, and refetching is the only
  // way to find out. "Ignore all resyncs" fails here.
  it('refetches on a resync that follows the connect-time one', async () => {
    const wire = serve()

    renderProvider(client())

    expect(await screen.findByText('1')).toBeInTheDocument()
    const stream = await wire.connection()
    wire.pushResync(stream)
    await settle()
    expect(wire.state.reads).toBe(1)

    wire.changeWhileDisconnected()
    wire.pushResync(stream)

    expect(await screen.findByText('2')).toBeInTheDocument()
    expect(wire.state.reads).toBe(2)
  })

  /**
   * The reason the suppression is scoped to the RUN and not to the connection
   * attempt.
   *
   * The server hangs every stream up at ~15 minutes and the client comes back
   * on its own — with no page load, no mount, and no fetch. The `resync` that
   * opens *that* connection is the client's only chance to reconcile whatever
   * moved during the gap. An implementation that reset its "first event" flag
   * per reconnect would swallow it and leave the dashboard stale until the user
   * navigated: this test fails against exactly that.
   */
  it('refetches on the resync that opens a reconnected stream', async () => {
    const wire = serve()

    renderProvider(client())

    expect(await screen.findByText('1')).toBeInTheDocument()
    const first = await wire.connection()
    // Come back promptly instead of on the 3s default base, so the reconnect
    // lands well inside the wait below.
    first.send('retry: 500\n\n')
    wire.pushResync(first)
    await settle()
    expect(wire.state.reads).toBe(1)

    // The ~15-minute recycle, in miniature: a clean hang-up, a gap, a new
    // stream.
    wire.changeWhileDisconnected()
    first.end()

    const second = await wire.connection(2)
    wire.pushResync(second)

    expect(await screen.findByText('2')).toBeInTheDocument()
    expect(wire.state.reads).toBe(2)
  })

  it('closes the stream when it unmounts', async () => {
    const connections: Request[] = []
    server.use(
      http.get('*/v1/stream', ({ request }) => {
        connections.push(request)
        return new HttpResponse(new ReadableStream<Uint8Array>(), {
          headers: { 'Content-Type': SSE_CONTENT_TYPE },
        })
      }),
    )
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })

    const { unmount } = render(
      <QueryClientProvider client={queryClient}>
        <RealtimeProvider>
          <p>content</p>
        </RealtimeProvider>
      </QueryClientProvider>,
    )

    await vi.waitFor(() => expect(connections).toHaveLength(1))
    unmount()

    // The request the provider opened is aborted, not left reading — which is
    // what stops a signed-out tab from repopulating a cleared cache.
    await vi.waitFor(() => expect(connections[0].signal.aborted).toBe(true))
  })
})
