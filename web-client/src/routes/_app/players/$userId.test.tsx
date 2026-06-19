import { render, screen, waitFor } from '@testing-library/react'
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { http, HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'

import { server } from '@/mocks/server'
import { sessionResponse } from '@/test/factories'
import { Route } from './$userId'

const PlayerRoute = Route.options.component!

/** A page worth of opponent rows — only the fields the profile table reads. */
function matchRows(count: number, page: number, pageSize: number) {
  const start = (page - 1) * pageSize
  return Array.from({ length: Math.max(0, Math.min(pageSize, count - start)) })
    .map((_, i) => ({
      id: `m-${start + i}`,
      opponent: { id: `opp-${start + i}`, username: `opp.${start + i}` },
      sets: [{ mine: 11, theirs: 7 }],
      result: 'W' as const,
      status: 'completed' as const,
      created_at: '2026-06-01T12:00:00Z',
    }))
}

function renderProfile(initialEntry: string) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  const rootRoute = createRootRoute()
  const profileRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/players/$userId',
    component: PlayerRoute,
    validateSearch: Route.options.validateSearch,
  })
  const router = createRouter({
    routeTree: rootRoute.addChildren([profileRoute]),
    history: createMemoryHistory({ initialEntries: [initialEntry] }),
  })
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
  return { router }
}

describe('player profile match-history pagination', () => {
  it('snaps an out-of-range ?page= back to the last valid page (#637)', async () => {
    const TOTAL = 28 // 2 pages at page_size 25
    server.use(
      http.get('*/v1/session', () => HttpResponse.json(sessionResponse())),
      http.get('*/v1/players/:playerId', () =>
        HttpResponse.json({
          id: 'p-1',
          username: 'rallymaster',
          rating: 1234,
          wins: 20,
          losses: 8,
          // Bundled first page — the profile paints page 1 from this.
          matches: {
            items: matchRows(TOTAL, 1, 25),
            page: 1,
            page_size: 25,
            total: TOTAL,
          },
        }),
      ),
      http.get('*/v1/players/:playerId/matches', ({ request }) => {
        const page = Number(new URL(request.url).searchParams.get('page') ?? '1')
        // page 1 → 25 rows, page 2 → 3 rows, anything beyond → empty (but
        // still the real total, exactly as the server behaves).
        return HttpResponse.json({
          items: matchRows(TOTAL, page, 25),
          page,
          page_size: 25,
          total: TOTAL,
        })
      }),
    )

    const { router } = renderProfile('/players/p-1?page=999')

    // The clamp redirects to the last valid page (2), so the real rows render
    // instead of the cold "No matches yet" empty state under a broken footer.
    expect(await screen.findByText('opp.25')).toBeInTheDocument()
    expect(screen.queryByText(/no matches yet/i)).not.toBeInTheDocument()

    await waitFor(() => {
      expect(router.state.location.search).toEqual(
        expect.objectContaining({ page: 2 }),
      )
    })

    // Footer range is sane — start never exceeds the total.
    expect(screen.getByText(/showing/i).textContent).toContain('26–28')
    expect(screen.queryByText(/24951/)).not.toBeInTheDocument()
  })
})
