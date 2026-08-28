import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { http, HttpResponse } from 'msw'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, render, screen, waitFor } from '@testing-library/react'
import { createElement } from 'react'

import { server } from '@/mocks/server'
import { dashboardResponse } from '@/test/factories'
import { RenderBoundary } from '@/test/utilities'
import { DASHBOARD_QUERY_KEY, useDashboard } from './dashboard'

let queryClient: QueryClient

beforeEach(() => {
  queryClient = new QueryClient({
    // A long staleTime means a re-read only refetches if something explicitly
    // invalidates the query, so the regression pair's background refetch is
    // the one we fire, not an incidental stale-by-default refetch.
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  })
})

afterEach(() => {
  queryClient.clear()
})

/** Reads exactly what a dashboard-consuming component reads off `useDashboard`
 * (`data`), so the throw-vs-keep behavior under test is the one the real
 * dashboard page sees. */
function DashboardView() {
  const { data } = useDashboard()
  return createElement(
    'div',
    null,
    data ? `waiting:${data.waiting_count}` : 'PENDING',
  )
}

const dashboardTree = () =>
  createElement(
    QueryClientProvider,
    { client: queryClient },
    createElement(RenderBoundary, null, createElement(DashboardView)),
  )

describe('useDashboard', () => {
  /**
   * Regression (#1468 — mirrors #843's fix in `matchQueryOptions`): a
   * background refetch of an already-rendered dashboard must not throw the
   * page out to the route error boundary. `throwOnError` is re-evaluated on
   * every render, so a bare `true` would eject the viewer the next time
   * anything else re-renders the page after a failed background refetch.
   */
  it('keeps last-good data on screen when a background refetch fails (#1468)', async () => {
    const seeded = dashboardResponse({ waiting_count: 2 })
    queryClient.setQueryData(DASHBOARD_QUERY_KEY, seeded)

    const { rerender } = render(dashboardTree())
    // The seeded data renders — no boundary, no pending.
    expect(screen.getByText('waiting:2')).toBeTruthy()

    server.use(
      http.get('*/v1/dashboard', () =>
        HttpResponse.json({ detail: 'boom' }, { status: 500 }),
      ),
    )

    // A background refetch that fails.
    await act(async () => {
      await queryClient
        .invalidateQueries({ queryKey: DASHBOARD_QUERY_KEY })
        .catch(() => undefined)
    })
    // The errored refetch leaves `data`/`isLoading` unchanged, so it alone
    // doesn't re-render this observer — force the next render, where a bare
    // `true` would throw.
    rerender(dashboardTree())

    expect(screen.queryByText('BOUNDARY')).toBeNull()
    expect(screen.getByText('waiting:2')).toBeTruthy()
    expect(queryClient.getQueryData(DASHBOARD_QUERY_KEY)).toEqual(seeded)
  })

  /**
   * The other half of the distinction: an *initial* load with no cached data
   * to fall back on must still throw so the surrounding boundary can render a
   * retry.
   */
  it('throws to the boundary when the initial dashboard load fails', async () => {
    server.use(
      http.get('*/v1/dashboard', () =>
        HttpResponse.json({ detail: 'boom' }, { status: 500 }),
      ),
    )

    render(dashboardTree())

    await waitFor(() => expect(screen.getByText('BOUNDARY')).toBeTruthy())
  })
})
