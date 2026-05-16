import { render, screen, waitFor, within } from '@testing-library/react'
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
import { matchDetails } from '@/test/factories'
import {
  MatchDetailsError,
  MatchDetailsView,
} from '@/components/matches/match-details-page'

function renderDetails(matchId: string) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  const rootRoute = createRootRoute()
  const detailsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/details',
    component: () => <MatchDetailsView matchId={matchId} />,
    errorComponent: MatchDetailsError,
  })
  // Route stubs the real route would navigate to — registered so typed
  // <Link>s in the page resolve at render time.
  const scoringNew = createRoute({
    getParentRoute: () => rootRoute,
    path: '/matches/$matchId/games/$gameId/scores/new',
    component: () => <div>scoring-new</div>,
  })
  const scoringEdit = createRoute({
    getParentRoute: () => rootRoute,
    path: '/matches/$matchId/games/$gameId/scores/$scoreId/edit',
    component: () => <div>scoring-edit</div>,
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
    routeTree: rootRoute.addChildren([
      detailsRoute,
      scoringNew,
      scoringEdit,
      matchesList,
      matchPage,
    ]),
    history: createMemoryHistory({ initialEntries: ['/details'] }),
  })
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
}

describe('MatchDetailsView', () => {
  it('renders the hero scoreline from my_side / opponent_side counts', async () => {
    const match = matchDetails({
      id: 'm-1',
      status: 'completed',
      status_label: 'Final',
      my_side: {
        side_number: 1,
        players: [{ user_id: 'u-me', username: 'me', is_current_user: true }],
        games_won: 3,
        won: true,
        is_current_user_side: true,
      },
      opponent_side: {
        side_number: 2,
        players: [
          { user_id: 'u-opp', username: 'nguyen.t', is_current_user: false },
        ],
        games_won: 1,
        won: false,
        is_current_user_side: false,
      },
      games: [],
      current_game: null,
      can_score: false,
    })
    server.use(
      http.get('*/v1/matches/m-1', () => HttpResponse.json(match)),
    )

    const { container } = renderDetails('m-1')

    // Wait for the hero to render; my_side.games_won and opp.games_won show
    // up as the headline score numbers.
    await waitFor(() =>
      expect(container.querySelector('.md-hero__name')).toHaveTextContent(
        'me',
      ),
    )
    const myScore = container.querySelector('.md-hero__score--l')
    const oppScore = container.querySelector('.md-hero__score--r')
    expect(myScore).toHaveTextContent('3')
    expect(oppScore).toHaveTextContent('1')
    // My side won — the win modifier is on the left, not the right.
    expect(myScore).toHaveClass('md-hero__score--win')
    expect(oppScore).not.toHaveClass('md-hero__score--win')
  })

  it('shows a Score CTA only when can_score is true and links to current_game', async () => {
    const game1 = { id: 'g-1', game_number: 1, score: null }
    const match = matchDetails({
      id: 'm-2',
      status: 'pending',
      status_label: 'Scheduled',
      games: [game1],
      current_game: { id: 'g-1', game_number: 1 },
      can_score: true,
    })
    server.use(
      http.get('*/v1/matches/m-2', () => HttpResponse.json(match)),
    )

    renderDetails('m-2')

    const scoreLink = await screen.findByRole('link', { name: 'Score' })
    expect(scoreLink).toHaveAttribute(
      'href',
      '/matches/m-2/games/g-1/scores/new',
    )
  })

  it('hides the Score CTA when can_score is false', async () => {
    const match = matchDetails({
      id: 'm-3',
      status: 'completed',
      can_score: false,
      current_game: null,
      games: [],
    })
    server.use(
      http.get('*/v1/matches/m-3', () => HttpResponse.json(match)),
    )

    const { container } = renderDetails('m-3')

    // Wait for the players card to render (one of its name nodes).
    await waitFor(() =>
      expect(container.querySelector('.md-profile__name')).toBeInTheDocument(),
    )
    expect(
      screen.queryByRole('link', { name: 'Score' }),
    ).not.toBeInTheDocument()
  })

  it('links each scored game cell on my row to its scores/$scoreId/edit route', async () => {
    const match = matchDetails({
      id: 'm-4',
      status: 'in_progress',
      status_label: 'Live',
      best_of: 5,
      games_to_win: 3,
      my_side: {
        side_number: 1,
        players: [{ user_id: 'u-me', username: 'me', is_current_user: true }],
        games_won: 1,
        won: null,
        is_current_user_side: true,
      },
      opponent_side: {
        side_number: 2,
        players: [
          { user_id: 'u-opp', username: 'opp', is_current_user: false },
        ],
        games_won: 0,
        won: null,
        is_current_user_side: false,
      },
      games: [
        {
          id: 'g-1',
          game_number: 1,
          score: { id: 's-1', my_points: 11, opponent_points: 4, is_my_win: true },
        },
        { id: 'g-2', game_number: 2, score: null },
      ],
      current_game: { id: 'g-2', game_number: 2 },
      can_score: true,
    })
    server.use(
      http.get('*/v1/matches/m-4', () => HttpResponse.json(match)),
    )

    renderDetails('m-4')

    await screen.findByRole('link', { name: 'Score' })
    // The first-game cell on my row is a link to the edit route for s-1.
    const editLink = screen.getByRole('link', { name: '11' })
    expect(editLink).toHaveAttribute(
      'href',
      '/matches/m-4/games/g-1/scores/s-1/edit',
    )
  })

  it('renders an error fallback when the match fails to load', async () => {
    server.use(
      http.get('*/v1/matches/m-missing', () =>
        HttpResponse.json({ detail: 'Match not found.' }, { status: 404 }),
      ),
    )
    renderDetails('m-missing')

    const alert = await screen.findByRole('alert')
    expect(within(alert).getByText(/couldn.t find that match/i)).toBeInTheDocument()
  })

  it('redirects solo matches (no opponent) back to /matches', async () => {
    const match = matchDetails({
      id: 'm-solo',
      opponent_side: null,
      games: [],
      current_game: null,
      can_score: false,
    })
    server.use(
      http.get('*/v1/matches/m-solo', () => HttpResponse.json(match)),
    )
    renderDetails('m-solo')

    await waitFor(() =>
      expect(screen.getByText('matches-list')).toBeInTheDocument(),
    )
  })
})
