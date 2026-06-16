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
import { Route } from './matches.$matchId.games.$gameNumber.scores.new'

// A well-formed UUID the seed data doesn't know about — passes the param-shape
// guard, so the route fetches and the API answers 404.
const UNKNOWN_MATCH_ID = '00000000-0000-4000-8000-000000000000'

const ScoreCreateRoute = Route.options.component!
const ScoreCreateError = Route.options.errorComponent!

// Mount the real scoring-create route under a memory router so we exercise the
// route's own param guard + error boundary (not just the inner component). The
// detail/list stubs cover the `<Link to="/matches">`/redirect targets the
// not-found fallback can resolve to.
function renderScoreCreate(matchId: string) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  const rootRoute = createRootRoute()
  const route = createRoute({
    getParentRoute: () => rootRoute,
    path: '/matches/$matchId/games/$gameNumber/scores/new',
    component: ScoreCreateRoute,
    errorComponent: ScoreCreateError,
  })
  const matchesList = createRoute({
    getParentRoute: () => rootRoute,
    path: '/matches',
    component: () => <div>matches-list</div>,
  })
  const matchPage = createRoute({
    getParentRoute: () => rootRoute,
    path: '/matches/$matchId',
    component: () => <div>match-page</div>,
  })
  const router = createRouter({
    routeTree: rootRoute.addChildren([route, matchesList, matchPage]),
    history: createMemoryHistory({
      initialEntries: [`/matches/${matchId}/games/1/scores/new`],
    }),
  })
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
}

describe('scoring-create route — bad/nonexistent match id (#385)', () => {
  it('renders the friendly not-found state for a malformed id without hitting the API', async () => {
    let requested = false
    server.use(
      http.get('*/v1/matches/:matchId', () => {
        requested = true
        return HttpResponse.json({ detail: 'Match not found.' }, { status: 404 })
      }),
    )

    renderScoreCreate('not-a-uuid')

    expect(
      await screen.findByText(/couldn.t find that match/i),
    ).toBeInTheDocument()
    // No raw crash page, and the back-to-matches dead end is offered.
    expect(screen.queryByText(/something went wrong/i)).not.toBeInTheDocument()
    expect(
      screen.getByRole('link', { name: /back to matches/i }),
    ).toHaveAttribute('href', '/matches')
    // The guard short-circuits before any fetch — no 422/404 round-trip.
    expect(requested).toBe(false)
  })

  it('catches a 404 from a valid-but-nonexistent id instead of crashing', async () => {
    server.use(
      http.get('*/v1/matches/:matchId', () =>
        HttpResponse.json({ detail: 'Match not found.' }, { status: 404 }),
      ),
    )

    renderScoreCreate(UNKNOWN_MATCH_ID)

    expect(
      await screen.findByText(/couldn.t find that match/i),
    ).toBeInTheDocument()
    expect(screen.queryByText(/something went wrong/i)).not.toBeInTheDocument()
    await waitFor(() =>
      expect(
        screen.getByRole('link', { name: /back to matches/i }),
      ).toBeInTheDocument(),
    )
  })
})
