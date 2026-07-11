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

import type { PlayerDetail } from '@/api/players'
import {
  buildPlayerDetail,
  buildUnratedPlayerDetail,
} from '@/mocks/factories/players/player-detail.factory'
import {
  buildLiveMatchRow,
  buildPlayerMatchList,
  buildPlayerMatchRow,
} from '@/mocks/factories/players/player-match-row.factory'
import { server } from '@/mocks/server'
import { sessionResponse } from '@/test/factories'
import { Route } from './$userId'

const ProfileRoute = Route.options.component!
const ProfileError = Route.options.errorComponent!

/**
 * Stub the session and the profile bundle every card projects off — and nothing
 * else. The profile is an overview now: it reads the six recent matches out of
 * that bundle, so `/v1/players/:id/matches` is deliberately left unstubbed and
 * MSW (`onUnhandledRequest: 'error'`) fails the test if the page calls it.
 */
function mockProfile(bundle: PlayerDetail) {
  server.use(
    http.get('*/v1/session', () => HttpResponse.json(sessionResponse())),
    http.get('*/v1/players/:playerId', () => HttpResponse.json(bundle)),
  )
}

/** The profile bundle fails — every card is projected off it, so nothing on the
 * page has anything to draw. */
function mockProfileFailure(status = 500) {
  server.use(
    http.get('*/v1/session', () => HttpResponse.json(sessionResponse())),
    http.get(
      '*/v1/players/:playerId',
      () => new HttpResponse(null, { status }),
    ),
  )
}

function renderProfile(initialEntry = '/players/p-1') {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  const rootRoute = createRootRoute()
  const profileRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/players/$userId',
    component: ProfileRoute,
    errorComponent: ProfileError,
    validateSearch: Route.options.validateSearch,
  })
  // The Recent matches card's footer is a typed <Link> to the full history, so
  // the route it opens must be registered for the link to resolve.
  const historyRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/players/$userId/matches',
    component: () => <div>match history</div>,
  })
  const router = createRouter({
    routeTree: rootRoute.addChildren([profileRoute, historyRoute]),
    history: createMemoryHistory({ initialEntries: [initialEntry] }),
  })
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
}

describe('player profile route', () => {
  it('paints the hero — rating, rank of the ladder, peak, form and member-since', async () => {
    mockProfile(
      buildPlayerDetail({
        username: 'rita.kovac',
        rating: 1687,
        rank: 3,
        rank_of: 42,
        peak: 1712,
        member_since: '2024-03-14T09:00:00Z',
        form: 'WWLWLLWWLW',
      }),
    )

    renderProfile()

    expect(
      await screen.findByRole('heading', { level: 1, name: 'rita.kovac' }),
    ).toBeInTheDocument()
    expect(screen.getByText('Member since Mar 2024')).toBeInTheDocument()
    expect(screen.getByText('1687')).toBeInTheDocument()
    // The rank is always reported out of the rated population — never "#3".
    expect(screen.getByText('#3 of 42')).toBeInTheDocument()
    expect(screen.getByText('1712')).toBeInTheDocument()
    // Ten results on the profile (the roster is the surface that shows five).
    expect(
      screen.getByLabelText('Last 10: W W L W L L W W L W'),
    ).toBeInTheDocument()
  })

  it('shows recent matches, with a link to the all-inclusive history', async () => {
    // 24 + 11 = 35 decided, 50 all-inclusive. The link names *fifty*, and the
    // live match is on the card rather than filtered out of it (ADR-0915).
    mockProfile(
      buildPlayerDetail({
        wins: 24,
        losses: 11,
        match_total: 50,
        matches: buildPlayerMatchList([
          buildPlayerMatchRow({
            opponent: { id: 'p-9', username: 'ada.lovelace' },
          }),
          buildLiveMatchRow({ opponent: { id: 'p-8', username: 'kai.zhou' } }),
        ]),
      }),
    )

    renderProfile()

    const link = await screen.findByRole('link', {
      name: 'View all 50 matches',
    })
    expect(link).toHaveAttribute('href', '/players/p-1/matches')
    expect(screen.getByText('kai.zhou')).toBeInTheDocument()
    expect(screen.getByRole('img', { name: 'Live' })).toBeInTheDocument()
    // No result-chip column survives on the profile.
    expect(screen.queryByText('LIVE')).not.toBeInTheDocument()
  })

  it('renders a stale “?page=” bookmark harmlessly', async () => {
    // `?page=` left the profile with the table (ADR-0915). An old
    // `/players/x?page=3` link must still open the profile — the param is simply
    // never consumed — rather than 404ing or erroring at the boundary.
    mockProfile(buildPlayerDetail({ username: 'rita.kovac' }))

    renderProfile('/players/p-1?page=3')

    expect(
      await screen.findByRole('heading', { level: 1, name: 'rita.kovac' }),
    ).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('shows an unrated player as Unrated, with no rank', async () => {
    // No rating, no rank — CONTEXT.md § Rank. Not a big number at the bottom of
    // the ladder, and not a "#null of 42".
    mockProfile(buildUnratedPlayerDetail({ username: 'park.j' }))

    renderProfile('/players/p-2')

    expect(await screen.findByText('Unrated')).toBeInTheDocument()
    expect(screen.queryByText(/^#\d+ of \d+$/)).not.toBeInTheDocument()
    expect(screen.queryByText('Rank')).not.toBeInTheDocument()
    expect(screen.queryByText('Peak')).not.toBeInTheDocument()
  })

  it('sends a failed bundle to the route’s error boundary', async () => {
    // No per-card boundary: the cards share one query, so a failure means none
    // of them has anything to draw.
    mockProfileFailure(500)

    renderProfile()

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument())
  })
})
