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

// A well-formed UUID with a live match behind it — passes the guard and
// renders the score-entry page (the positive case the e2e regression hit when
// the param guard rejected the non-UUID mock id).
const LIVE_MATCH_ID = '22070000-0000-4000-8000-000000000000'

function liveMatchDetails() {
  return {
    id: LIVE_MATCH_ID,
    status: 'in_progress',
    status_label: 'Live',
    best_of: 5,
    games_to_win: 3,
    team_size: 1,
    affects_rating: true,
    created_at: '2026-05-12T19:00:00Z',
    sides: [
      {
        side_number: 1,
        players: [{ user_id: 'u-me', username: 'rita.kovac', is_current_user: true }],
        games_won: 1,
        won: null,
        is_current_user_side: true,
      },
      {
        side_number: 2,
        players: [{ user_id: 'u-opp', username: 'nguyen.t', is_current_user: false }],
        games_won: 1,
        won: null,
        is_current_user_side: false,
      },
    ],
    games: [
      {
        id: 'g-1',
        game_number: 1,
        score: { id: 's-1', side_1_points: 11, side_2_points: 8, winner_side_number: 1 },
      },
      {
        id: 'g-2',
        game_number: 2,
        score: { id: 's-2', side_1_points: 9, side_2_points: 11, winner_side_number: 2 },
      },
    ],
    current_game: { game_number: 3 },
    can_score: true,
    can_finalize: false,
    negotiation: {
      viewer_state: 'live',
      your_turn: false,
      standing_result: null,
      prior_result: null,
      diff: null,
    },
  }
}

const ScoreCreateRoute = Route.options.component!
const ScoreCreateError = Route.options.errorComponent!

// Mount the real scoring-create route under a memory router so we exercise the
// route's own param guard + error boundary (not just the inner component). The
// detail/list stubs cover the `<Link to="/matches">`/redirect targets the
// not-found fallback can resolve to.
function renderScoreCreate(matchId: string, gameNumber = 1) {
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
      initialEntries: [`/matches/${matchId}/games/${gameNumber}/scores/new`],
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

  it('renders the score-entry page for a well-formed id with a live match', async () => {
    server.use(
      http.get('*/v1/matches/:matchId', () =>
        HttpResponse.json(liveMatchDetails()),
      ),
    )

    renderScoreCreate(LIVE_MATCH_ID, 3)

    // The param guard lets a UUID-shaped id through, the fetch resolves, and
    // the entry screen renders its heading — never the not-found dead end.
    expect(
      await screen.findByRole('heading', { name: /enter game 3 score/i }),
    ).toBeInTheDocument()
    expect(
      screen.queryByText(/couldn.t find that match/i),
    ).not.toBeInTheDocument()
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
