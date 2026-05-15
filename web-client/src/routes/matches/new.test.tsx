import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { delay, http, HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'
import type { components } from '@/api/schema'
import { server } from '@/mocks/server'
import { Route } from './new'

type MatchRead = components['schemas']['MatchRead']

// The page component isn't exported (route files should only export `Route`,
// so the router plugin can code-split them) — pull it off the route instead.
const NewMatchPage = Route.options.component!

function pendingMatch(): MatchRead {
  return {
    id: 'm-test',
    status: 'pending',
    created_by_user_id: 'u-test',
    created_at: '2026-05-14T00:00:00Z',
    settings: {
      team_size: 1,
      best_of: 5,
      affects_rating: false,
      verification_policy: 'none',
    },
    sides: [],
  }
}

function renderNewMatch() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  const rootRoute = createRootRoute()
  const newMatchRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/matches/new',
    component: NewMatchPage,
  })
  const dashboardRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/dashboard',
    component: () => <div>Dashboard route</div>,
  })
  const scoringRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/matches/$matchId/games/$gameId/scores/new',
    component: () => {
      const { matchId, gameId } = scoringRoute.useParams()
      return <div>Scoring route {matchId} game {gameId}</div>
    },
  })
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      newMatchRoute,
      dashboardRoute,
      scoringRoute,
    ]),
    history: createMemoryHistory({ initialEntries: ['/matches/new'] }),
  })
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
}

describe('NewMatchPage', () => {
  it('blocks a rated match with no opponent and shows an inline error', async () => {
    const user = userEvent.setup()
    renderNewMatch()

    // Rated is on by default and no opponent is picked yet.
    await user.click(
      await screen.findByRole('button', { name: /start match/i }),
    )

    expect(await screen.findByRole('alert')).toHaveTextContent(
      /rated match needs an opponent/i,
    )
    // Still on the match page — nothing was submitted.
    expect(
      screen.getByRole('heading', { level: 1, name: /new match/i }),
    ).toBeInTheDocument()
  })

  it('creates a match against a picked opponent and navigates to the dashboard', async () => {
    const user = userEvent.setup()
    let captured: unknown = null
    server.use(
      http.get('*/v1/players/recent', () =>
        HttpResponse.json([
          { id: 'pl-1', username: 'ada.lovelace' },
          { id: 'pl-2', username: 'grace.hopper' },
        ]),
      ),
      http.post('*/v1/matches', async ({ request }) => {
        captured = await request.json()
        return HttpResponse.json(pendingMatch(), { status: 201 })
      }),
    )
    renderNewMatch()

    await user.click(
      await screen.findByRole('button', { name: /ada\.lovelace/i }),
    )
    await user.click(screen.getByRole('button', { name: /start match/i }))

    await waitFor(() =>
      expect(
        screen.getByText('Scoring route m-test game 1'),
      ).toBeInTheDocument(),
    )
    expect(captured).toEqual({
      opponent_user_id: 'pl-1',
      best_of: 5,
      rated: true,
    })
  })

  it('starts a single-sided unrated match when no opponent is chosen', async () => {
    const user = userEvent.setup()
    let captured: unknown = null
    server.use(
      http.post('*/v1/matches', async ({ request }) => {
        captured = await request.json()
        return HttpResponse.json(pendingMatch(), { status: 201 })
      }),
    )
    renderNewMatch()

    await user.click(
      await screen.findByRole('button', { name: /start without opponent/i }),
    )
    await user.click(screen.getByRole('button', { name: /start match/i }))

    await waitFor(() =>
      expect(
        screen.getByText('Scoring route m-test game 1'),
      ).toBeInTheDocument(),
    )
    // Guest / TBD opponents can't be rated, so `rated` is forced false.
    expect(captured).toEqual({
      opponent_user_id: null,
      best_of: 5,
      rated: false,
    })
  })

  it('surfaces the API error detail when match creation fails', async () => {
    const user = userEvent.setup()
    server.use(
      http.get('*/v1/players/recent', () =>
        HttpResponse.json([{ id: 'pl-1', username: 'ada.lovelace' }]),
      ),
      http.post('*/v1/matches', () =>
        HttpResponse.json({ detail: 'opponent not found' }, { status: 404 }),
      ),
    )
    renderNewMatch()

    await user.click(
      await screen.findByRole('button', { name: /ada\.lovelace/i }),
    )
    await user.click(screen.getByRole('button', { name: /start match/i }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      /opponent not found/i,
    )
  })
})

describe('NewMatchPage — recent opponents', () => {
  it('shows a skeleton while recent opponents load, then the chips', async () => {
    server.use(
      http.get('*/v1/players/recent', async () => {
        await delay(80)
        return HttpResponse.json([{ id: 'pl-1', username: 'ada.lovelace' }])
      }),
    )
    renderNewMatch()

    // The placeholder grid is up while the request is in flight.
    expect(
      await screen.findByRole('status', { name: /loading players/i }),
    ).toBeInTheDocument()

    // ...then the real chip replaces it.
    expect(
      await screen.findByRole('button', { name: /ada\.lovelace/i }),
    ).toBeInTheDocument()
    expect(
      screen.queryByRole('status', { name: /loading players/i }),
    ).not.toBeInTheDocument()
  })

  it('renders recent opponents in the order the endpoint returns them', async () => {
    server.use(
      http.get('*/v1/players/recent', () =>
        HttpResponse.json([
          { id: 'pl-3', username: 'carol.recent' },
          { id: 'pl-1', username: 'alice.older' },
          { id: 'pl-2', username: 'bob.oldest' },
        ]),
      ),
    )
    const { container } = renderNewMatch()

    await screen.findByRole('button', { name: /carol\.recent/i })
    const names = [...container.querySelectorAll('.nm-chip .n')].map(
      (node) => node.textContent,
    )
    // Most-recently-played first — the client preserves the endpoint's order.
    expect(names).toEqual(['carol.recent', 'alice.older', 'bob.oldest'])
  })

  it('shows an empty state when there are no other players', async () => {
    server.use(http.get('*/v1/players/recent', () => HttpResponse.json([])))
    renderNewMatch()

    expect(
      await screen.findByText(/no other players yet/i),
    ).toBeInTheDocument()
    // With nobody to find, the search affordance is hidden.
    expect(
      screen.queryByRole('button', { name: /search all players/i }),
    ).not.toBeInTheDocument()
  })

  it('shows a retry button when recent opponents fail to load, and recovers', async () => {
    const user = userEvent.setup()
    let calls = 0
    server.use(
      http.get('*/v1/players/recent', () => {
        calls += 1
        if (calls === 1) {
          return HttpResponse.json(
            { detail: 'database unavailable' },
            { status: 500 },
          )
        }
        return HttpResponse.json([{ id: 'pl-1', username: 'ada.lovelace' }])
      }),
    )
    renderNewMatch()

    // The picker boundary catches the failed load and offers a retry.
    expect(await screen.findByRole('alert')).toHaveTextContent(
      /couldn.t load players/i,
    )

    await user.click(screen.getByRole('button', { name: /try again/i }))

    // The retried request succeeds and the picker renders normally.
    expect(
      await screen.findByRole('button', { name: /ada\.lovelace/i }),
    ).toBeInTheDocument()
  })
})

describe('NewMatchPage — opponent search', () => {
  function recentWithOne() {
    return http.get('*/v1/players/recent', () =>
      HttpResponse.json([{ id: 'pl-1', username: 'ada.lovelace' }]),
    )
  }

  it('hits the dedicated search endpoint as the player types', async () => {
    const user = userEvent.setup()
    const queries: string[] = []
    server.use(
      recentWithOne(),
      http.get('*/v1/players/search', ({ request }) => {
        queries.push(new URL(request.url).searchParams.get('q') ?? '')
        return HttpResponse.json([
          { id: 'pl-9', username: 'barbara.liskov' },
        ])
      }),
    )
    renderNewMatch()

    await user.click(
      await screen.findByRole('button', { name: /search all players/i }),
    )
    await user.type(
      screen.getByPlaceholderText(/search by username/i),
      'liskov',
    )

    // The server-side result is selectable straight from the dropdown.
    await user.click(
      await screen.findByRole('button', { name: /barbara\.liskov/i }),
    )
    expect(screen.getByText(/registered player/i)).toBeInTheDocument()
    // The query reached the endpoint — nothing was filtered client-side.
    expect(queries.at(-1)).toBe('liskov')
  })

  it('shows a hint before typing and a no-match message for an unknown name', async () => {
    const user = userEvent.setup()
    server.use(
      recentWithOne(),
      http.get('*/v1/players/search', () => HttpResponse.json([])),
    )
    renderNewMatch()

    await user.click(
      await screen.findByRole('button', { name: /search all players/i }),
    )
    expect(screen.getByText(/start typing to search/i)).toBeInTheDocument()

    await user.type(
      screen.getByPlaceholderText(/search by username/i),
      'nobody-here',
    )
    expect(await screen.findByText(/no one matches/i)).toBeInTheDocument()
  })

  it('catches a failed search in the picker error boundary', async () => {
    const user = userEvent.setup()
    server.use(
      recentWithOne(),
      http.get('*/v1/players/search', () =>
        HttpResponse.json({ detail: 'search unavailable' }, { status: 500 }),
      ),
    )
    renderNewMatch()

    await user.click(
      await screen.findByRole('button', { name: /search all players/i }),
    )
    await user.type(
      screen.getByPlaceholderText(/search by username/i),
      'ada',
    )

    expect(await screen.findByRole('alert')).toHaveTextContent(
      /couldn.t load players/i,
    )
  })
})
