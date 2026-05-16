import { render, screen } from '@testing-library/react'
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
import {
  dashboardNextMatch,
  dashboardRecentResult,
  dashboardResponse,
  dashboardScoreBanner,
} from '@/test/factories'
import { DashboardPage } from './dashboard-page'

function renderDashboard() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  const rootRoute = createRootRoute()
  const dashboardRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/dashboard',
    component: DashboardPage,
  })
  const newMatchRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/matches/new',
    component: () => <div>New match route</div>,
  })
  const matchDetailRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/matches/$matchId',
    component: () => {
      const { matchId } = matchDetailRoute.useParams()
      return <div>Match detail {matchId}</div>
    },
  })
  const scoringRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/matches/$matchId/games/$gameId/scores/new',
    component: () => {
      const { matchId, gameId } = scoringRoute.useParams()
      return (
        <div>
          Scoring route {matchId} game {gameId}
        </div>
      )
    },
  })
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      dashboardRoute,
      newMatchRoute,
      matchDetailRoute,
      scoringRoute,
    ]),
    history: createMemoryHistory({ initialEntries: ['/dashboard'] }),
  })
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
}

describe('DashboardPage', () => {
  it('renders the wired widgets against the dashboard response', async () => {
    server.use(
      http.get('*/v1/dashboard', () =>
        HttpResponse.json(
          dashboardResponse({
            score_banner: dashboardScoreBanner({
              match_id: 'm-banner',
              current_game_id: 'g-banner-1',
              opponent_username: 'nguyen.t',
            }),
            next_match: dashboardNextMatch({
              match_id: 'm-next',
              opponent_username: 'okafor.d',
              best_of: 5,
            }),
            recent_results: [
              dashboardRecentResult({
                match_id: 'm-recent-1',
                opponent_username: 'silva.r',
                is_win: true,
                my_games_won: 3,
                opponent_games_won: 1,
              }),
              dashboardRecentResult({
                match_id: 'm-recent-2',
                opponent_username: 'patel.m',
                is_win: false,
                my_games_won: 1,
                opponent_games_won: 3,
              }),
            ],
          }),
        ),
      ),
    )
    renderDashboard()

    expect(await screen.findByTestId('dashboard-score-banner')).toHaveTextContent(
      'vs nguyen.t',
    )
    expect(await screen.findByTestId('dashboard-next-match')).toBeInTheDocument()
    expect(screen.getByText('okafor.d')).toBeInTheDocument()
    expect(screen.getByText('Best of 5')).toBeInTheDocument()
    const recent = await screen.findByTestId('dashboard-recent-results')
    const table = recent.parentElement?.querySelector('table')
    expect(table).not.toBeNull()
    expect(table).toHaveTextContent('silva.r')
    expect(table).toHaveTextContent('patel.m')
    expect(table).toHaveTextContent('3-1')
    expect(table).toHaveTextContent('1-3')
  })

  it('omits the score banner when none is active and shows the empty next-match card', async () => {
    server.use(
      http.get('*/v1/dashboard', () =>
        HttpResponse.json(
          dashboardResponse({
            score_banner: null,
            next_match: null,
            recent_results: [],
          }),
        ),
      ),
    )
    renderDashboard()

    await screen.findByText('No upcoming match yet.')
    expect(screen.queryByTestId('dashboard-score-banner')).not.toBeInTheDocument()
    expect(screen.getByText('No completed matches yet.')).toBeInTheDocument()
  })

  it('Log a match navigates to /matches/new', async () => {
    server.use(
      http.get('*/v1/dashboard', () =>
        HttpResponse.json(dashboardResponse()),
      ),
    )
    renderDashboard()

    const link = await screen.findByRole('link', { name: /log a match/i })
    expect(link).toHaveAttribute('href', '/matches/new')
  })

  it('Enter final score links to the current-game scoring route', async () => {
    server.use(
      http.get('*/v1/dashboard', () =>
        HttpResponse.json(
          dashboardResponse({
            score_banner: dashboardScoreBanner({
              match_id: 'm-banner',
              current_game_id: 'g-banner-1',
              opponent_username: 'nguyen.t',
            }),
          }),
        ),
      ),
    )
    renderDashboard()

    const link = await screen.findByRole('link', { name: /enter final score/i })
    expect(link).toHaveAttribute(
      'href',
      '/matches/m-banner/games/g-banner-1/scores/new',
    )
  })
})
