import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { http, HttpResponse } from 'msw'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { useDashboard } from '@/api/dashboard'
import { closeRealtimeConnections } from '@/api/realtime/connection'
import { SSE_CONTENT_TYPE } from '@/mocks/realtime-stream'
import { server } from '@/mocks/server'
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
 */

type DashboardResponse = components['schemas']['DashboardResponse']

function dashboardWith(attentionTotal: number): DashboardResponse {
  return {
    attention: [],
    attention_total_count: attentionTotal,
    waiting_count: 0,
    rating: null,
    completed_match_count: 0,
    recent_results: [],
    tournaments: [],
  }
}

/** A hand-driven `/v1/stream`, plus a `/v1/dashboard` whose answer the test
 * changes between reads — so a refetch is visible as a different number. */
function serve() {
  const state = { attentionTotal: 1, reads: 0 }
  let push!: (frame: string) => void

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      push = (frame) => controller.enqueue(new TextEncoder().encode(frame))
    },
  })

  server.use(
    http.get('*/v1/stream', () => {
      return new HttpResponse(body, {
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
    /** What the server would publish after, say, an opponent posts a result. */
    pushDashboardChanged: () => {
      state.attentionTotal += 1
      push('data: {"v":1,"kind":"dashboard.changed","ts":"2026-07-24T18:02:11Z"}\n\n')
    },
  }
}

/** Renders the one number the dashboard query carries, so a refetch is
 * observable in the DOM rather than in a spy. */
function AttentionCount() {
  const dashboard = useDashboard()
  return <p data-testid="count">{dashboard.data?.attention_total_count ?? '…'}</p>
}

afterEach(() => closeRealtimeConnections())

describe('RealtimeProvider', () => {
  it('refetches the dashboard when the server pushes a hint', async () => {
    const wire = serve()
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: 30_000 } },
    })
    const hrefBefore = window.location.href

    render(
      <QueryClientProvider client={queryClient}>
        <RealtimeProvider>
          <AttentionCount />
        </RealtimeProvider>
      </QueryClientProvider>,
    )

    expect(await screen.findByText('1')).toBeInTheDocument()
    expect(wire.state.reads).toBe(1)

    wire.pushDashboardChanged()

    // The rendered number moves on its own. `staleTime: 30_000` is left at the
    // app's real value on purpose: an invalidation has to beat it, which is
    // exactly what a cache-freshness window would not do.
    expect(await screen.findByText('2')).toBeInTheDocument()
    expect(wire.state.reads).toBe(2)

    // Nothing navigated and nothing reloaded — the same document, the same URL.
    expect(window.location.href).toBe(hrefBefore)
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
