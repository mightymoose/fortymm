import { render, screen, waitFor, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { http, HttpResponse } from 'msw'
import { beforeEach, describe, expect, it } from 'vitest'
import { mockSession } from '@/mocks/handlers'
import { server } from '@/mocks/server'
import {
  dashboardAttentionItem,
  dashboardRating,
  dashboardRecentResult,
  dashboardResponse,
  sessionResponse,
} from '@/test/factories'
import { GUEST_PERSIST_DISMISS_KEY } from './guest-persist-banner'
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
  const matchesRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/matches',
    component: () => <div>Matches route</div>,
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
  const settingsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/settings',
    component: () => <div>Settings route</div>,
  })
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      dashboardRoute,
      newMatchRoute,
      matchesRoute,
      scoringRoute,
      settingsRoute,
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
            // Wiring only: the panel's rows/footer/routing are pinned by the
            // attention-panel and attention-panel-view tests. Here we just
            // confirm the dashboard feeds the response into the panel.
            attention: [
              dashboardAttentionItem({
                match_id: 'm-attn',
                kind: 'score',
                current_game_number: 1,
                opponent_username: 'nguyen.t',
              }),
            ],
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

    const panel = await screen.findByRole('region', {
      name: /needs your attention/i,
    })
    expect(panel).toHaveTextContent('vs nguyen.t')
    const recent = await screen.findByTestId('dashboard-recent-results')
    const table = recent.parentElement?.querySelector('table')
    expect(table).not.toBeNull()
    expect(table).toHaveTextContent('silva.r')
    expect(table).toHaveTextContent('patel.m')
    expect(table).toHaveTextContent('3-1')
    expect(table).toHaveTextContent('1-3')
  })

  it('greets the signed-in user by their username', async () => {
    // Stub the session explicitly rather than leaning on the shared mutable
    // `mockSession` default — handlers like `PATCH /v1/me` mutate that
    // singleton in place, so a sibling test's leak could otherwise flip the
    // expected username under a reorder (#288).
    server.use(
      http.get('*/v1/session', () =>
        HttpResponse.json(
          sessionResponse({ user: { username: 'rita.kovac' } }),
        ),
      ),
      http.get('*/v1/dashboard', () =>
        // The greeting renders unconditionally above the isFirstMatch branch,
        // but keep this on the normal dashboard path anyway so the test
        // exercises the AttentionPanel/YourGameRow wiring it was written for.
        HttpResponse.json(dashboardResponse({ completed_match_count: 1 })),
      ),
    )
    renderDashboard()

    expect(
      await screen.findByRole('heading', { name: /Hi, rita\.kovac/ }),
    ).toBeInTheDocument()
  })

  it('falls back to a bare "Hi" when the session fails to load (#287)', async () => {
    // A 401 (session merged away) errors immediately — the session query skips
    // its retry on 401 — so the page settles into its error state.
    server.use(
      http.get('*/v1/session', () => new HttpResponse(null, { status: 401 })),
    )
    renderDashboard()

    // No username is available on a session error, so the greeting renders
    // without one rather than reading a stale value.
    expect(
      await screen.findByRole('heading', { name: /^Hi\.?$/ }),
    ).toBeInTheDocument()
    expect(
      screen.queryByRole('heading', { name: /Hi, \S/ }),
    ).not.toBeInTheDocument()
  })

  it('hides the attention panel and shows the empty recent-results card when nothing is pending', async () => {
    server.use(
      http.get('*/v1/dashboard', () =>
        HttpResponse.json(
          dashboardResponse({
            attention: [],
            waiting_count: 0,
            recent_results: [],
            // At least one completed match keeps this on the normal
            // dashboard path rather than the zero-match first-match layout
            // (see the "first-match" describe block below), which is what
            // this test is actually pinning: an empty *recent-results* card
            // with the attention panel hidden.
            completed_match_count: 1,
          }),
        ),
      ),
    )
    renderDashboard()

    await screen.findByText('No completed matches yet.')
    // Nothing actionable and nobody waiting: the panel disappears entirely.
    expect(
      screen.queryByRole('region', { name: /needs your attention/i }),
    ).not.toBeInTheDocument()
  })

  it('Log a match navigates to /matches/new', async () => {
    server.use(
      http.get('*/v1/dashboard', () =>
        // The PageTitle action renders unconditionally above the isFirstMatch
        // branch, but keep this on the normal dashboard path anyway so the
        // test exercises the AttentionPanel/YourGameRow wiring it was
        // written for.
        HttpResponse.json(dashboardResponse({ completed_match_count: 1 })),
      ),
    )
    renderDashboard()

    const link = await screen.findByRole('link', { name: /log a match/i })
    expect(link).toHaveAttribute('href', '/matches/new')
  })

  it('Full history links to /matches filtered by the current user', async () => {
    server.use(
      http.get('*/v1/dashboard', () =>
        // "Full history" lives in YourGameRow's header, which only renders on
        // the normal (not first-match) dashboard path.
        HttpResponse.json(dashboardResponse({ completed_match_count: 1 })),
      ),
    )
    renderDashboard()

    const link = await screen.findByRole('link', { name: /full history/i })
    // The link renders before the session query resolves; once the username
    // lands the search params update, so poll the attribute rather than
    // asserting it on first paint.
    await waitFor(() =>
      expect(link).toHaveAttribute('href', '/matches?q=rita.kovac'),
    )
  })

  it('renders the rating card from the dashboard rating payload', async () => {
    server.use(
      http.get('*/v1/dashboard', () =>
        HttpResponse.json(
          dashboardResponse({
            // Escapes the zero-match first-match layout without also
            // tripping the guest-persistence banner (>=1 completed match),
            // which would render its own "1612" and make the rating text
            // ambiguous below.
            attention_total_count: 1,
            rating: dashboardRating({
              league_name: 'FortyMM',
              current: 1612,
              delta: 24,
              peak: 1620,
              percentile: 78,
              spark_data: [1500, 1530, 1560, 1588, 1612],
              streak: { kind: 'W', n: 3 },
              stats: [
                { label: 'RD', value: '142' },
                { label: 'Volatility', value: '0.054' },
              ],
            }),
          }),
        ),
      ),
    )
    renderDashboard()

    // The rating is rounded for display.
    expect(await screen.findByText('1612')).toBeInTheDocument()
    expect(screen.getByText('+24 last match')).toBeInTheDocument()
    expect(screen.getByText('W3')).toBeInTheDocument()
    expect(screen.getByText('78%')).toBeInTheDocument()
    expect(screen.getByText(/FortyMM/i)).toBeInTheDocument()
  })

  it('hides the rating card when the user has no rated league', async () => {
    server.use(
      http.get('*/v1/dashboard', () =>
        // At least one completed match keeps this on the normal dashboard
        // path (see the "first-match" describe block below).
        HttpResponse.json(
          dashboardResponse({ rating: null, completed_match_count: 1 }),
        ),
      ),
    )
    renderDashboard()

    await screen.findByText('Not in a rated league yet.')
    // The full rating card renders an "RD" stat tile — its absence confirms
    // we fell through to the empty state rather than the live card.
    expect(screen.queryByText('RD')).not.toBeInTheDocument()
  })

})

describe('DashboardPage · first-match (zero completed matches, nothing pending)', () => {
  it('renders the hero, unrated, and empty-matches cards instead of the normal layout', async () => {
    server.use(
      http.get('*/v1/dashboard', () =>
        HttpResponse.json(
          dashboardResponse({
            completed_match_count: 0,
            rating: null,
            recent_results: [],
            attention: [],
            attention_total_count: 0,
          }),
        ),
      ),
    )
    renderDashboard()

    expect(
      await screen.findByRole('heading', { name: /log your first match/i }),
    ).toBeInTheDocument()
    expect(screen.getByText('Unrated')).toBeInTheDocument()
    expect(screen.getByText('No matches yet. Go play.')).toBeInTheDocument()
    expect(
      screen.queryByRole('region', { name: /needs your attention/i }),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByText('Not in a rated league yet.'),
    ).not.toBeInTheDocument()
  })

  it('never puts a rating number in front of a player who has never played (#950)', async () => {
    // The regression: this dashboard hardcoded `1500 · PROVISIONAL` while the
    // player's own profile, the roster, their leagues card and the opponent
    // picker all — correctly — said Unrated. Joining a league seeds
    // `rating_value = 1500` on session-mint, before a ball is hit; that seed is
    // the strategy's prior, not a rating anyone earned, and the API now sends
    // `rating: null` here (CONTEXT.md § Rating).
    //
    // The assertion is on the *shape*, not on the literal 1500: any run of 3-4
    // digits is rating-shaped, so re-hardcoding 1600 — or quoting a league's
    // `initial_rating_value` back at the player — reds this too.
    server.use(
      http.get('*/v1/dashboard', () =>
        HttpResponse.json(
          dashboardResponse({
            completed_match_count: 0,
            rating: null,
            recent_results: [],
            attention: [],
            attention_total_count: 0,
            waiting_count: 0,
          }),
        ),
      ),
    )
    const { container } = renderDashboard()

    await screen.findByRole('heading', { name: /log your first match/i })
    expect(container.textContent).not.toMatch(/\b\d{3,4}\b/)
    expect(screen.queryByText(/provisional/i)).not.toBeInTheDocument()
    // …and it does say the true thing in the number's place.
    expect(screen.getByText('Unrated')).toBeInTheDocument()
  })

  it('stays on the normal dashboard when an attention item exists despite zero completed matches', async () => {
    server.use(
      http.get('*/v1/dashboard', () =>
        HttpResponse.json(
          dashboardResponse({
            completed_match_count: 0,
            rating: null,
            recent_results: [],
            attention: [
              dashboardAttentionItem({
                match_id: 'm-live',
                kind: 'score',
                current_game_number: 2,
                opponent_username: 'nguyen.t',
              }),
            ],
          }),
        ),
      ),
    )
    renderDashboard()

    const panel = await screen.findByRole('region', {
      name: /needs your attention/i,
    })
    expect(panel).toHaveTextContent('vs nguyen.t')
    expect(
      screen.queryByRole('heading', { name: /log your first match/i }),
    ).not.toBeInTheDocument()
  })

  it('stays on the normal dashboard when a match is passively waiting despite zero completed matches', async () => {
    server.use(
      http.get('*/v1/dashboard', () =>
        HttpResponse.json(
          dashboardResponse({
            completed_match_count: 0,
            rating: null,
            recent_results: [],
            attention: [],
            attention_total_count: 0,
            waiting_count: 1,
          }),
        ),
      ),
    )
    renderDashboard()

    // AttentionPanel itself stays hidden (it renders nothing for an empty
    // `attention` list regardless of `waitingCount`), so pin the normal
    // dashboard path via YourGameRow's own "Your game" section instead.
    expect(
      await screen.findByRole('heading', { name: /your game/i }),
    ).toBeInTheDocument()
    expect(
      screen.queryByRole('heading', { name: /log your first match/i }),
    ).not.toBeInTheDocument()
  })

  it('shows no guest-persistence banner in the first-match layout', async () => {
    server.use(
      http.get('*/v1/dashboard', () =>
        HttpResponse.json(
          dashboardResponse({
            completed_match_count: 0,
            rating: null,
            recent_results: [],
            attention: [],
            attention_total_count: 0,
          }),
        ),
      ),
    )
    renderDashboard()

    await screen.findByRole('heading', { name: /log your first match/i })
    expect(
      screen.queryByTestId('dashboard-guest-persist-banner'),
    ).not.toBeInTheDocument()
  })
})

describe('DashboardPage · guest persistence banner', () => {
  // The mock session is module-shared mutable state; snapshot every field
  // deriveEmailStatus reads so unrelated suites can't bleed into ours.
  const originalConfirmedAt = mockSession.data.user.confirmed_at
  const originalEmail = mockSession.data.user.email
  const originalPendingEmail = mockSession.data.user.pending_email

  beforeEach(() => {
    window.sessionStorage.removeItem(GUEST_PERSIST_DISMISS_KEY)
    mockSession.data.user.confirmed_at = originalConfirmedAt
    mockSession.data.user.email = originalEmail
    mockSession.data.user.pending_email = originalPendingEmail
  })

  it("shows for a guest with one or more completed matches and quotes the user's history", async () => {
    server.use(
      http.get('*/v1/dashboard', () =>
        HttpResponse.json(
          dashboardResponse({
            completed_match_count: 4,
            rating: dashboardRating({ current: 1847 }),
          }),
        ),
      ),
    )
    renderDashboard()

    const banner = await screen.findByTestId('dashboard-guest-persist-banner')
    expect(banner).toHaveTextContent('4')
    expect(banner).toHaveTextContent(/matches and rating/i)
    expect(banner).toHaveTextContent('1847')
    expect(banner).toHaveTextContent(/live on this device only/i)
    const cta = within(banner).getByRole('link', { name: /add an email/i })
    expect(cta).toHaveAttribute('href', '/settings#sec-email')
  })

  it('drops the rating fragment when the user has no rated league', async () => {
    server.use(
      http.get('*/v1/dashboard', () =>
        HttpResponse.json(
          dashboardResponse({ completed_match_count: 1, rating: null }),
        ),
      ),
    )
    renderDashboard()

    const banner = await screen.findByTestId('dashboard-guest-persist-banner')
    expect(banner).toHaveTextContent('Your 1 match live on this device only.')
    expect(banner).not.toHaveTextContent(/rating/i)
  })

  it('stays hidden for a zero-match guest — nothing to lose yet', async () => {
    server.use(
      http.get('*/v1/dashboard', () =>
        HttpResponse.json(
          dashboardResponse({ completed_match_count: 0, rating: null }),
        ),
      ),
    )
    renderDashboard()

    // Wait until something else from the dashboard has rendered, then
    // confirm the banner is absent.
    await screen.findByRole('heading', { name: /Hi, rita\.kovac/ })
    expect(
      screen.queryByTestId('dashboard-guest-persist-banner'),
    ).not.toBeInTheDocument()
  })

  it('stays hidden for verified users regardless of match count', async () => {
    mockSession.data.user.email = 'rita@example.com'
    mockSession.data.user.confirmed_at = '2026-05-01T10:00:00Z'
    server.use(
      http.get('*/v1/dashboard', () =>
        HttpResponse.json(dashboardResponse({ completed_match_count: 12 })),
      ),
    )
    renderDashboard()

    await screen.findByRole('heading', { name: /Hi, rita\.kovac/ })
    expect(
      screen.queryByTestId('dashboard-guest-persist-banner'),
    ).not.toBeInTheDocument()
  })

  it('disappears on dismiss and stays dismissed within the session', async () => {
    server.use(
      http.get('*/v1/dashboard', () =>
        HttpResponse.json(dashboardResponse({ completed_match_count: 2 })),
      ),
    )
    const { unmount } = renderDashboard()
    const banner = await screen.findByTestId('dashboard-guest-persist-banner')
    await userEvent.click(
      within(banner).getByRole('button', { name: /dismiss/i }),
    )
    await waitFor(() =>
      expect(
        screen.queryByTestId('dashboard-guest-persist-banner'),
      ).not.toBeInTheDocument(),
    )
    expect(
      window.sessionStorage.getItem(GUEST_PERSIST_DISMISS_KEY),
    ).toBe('1')

    // Re-mount within the same "session" — the banner should remain hidden.
    unmount()
    renderDashboard()
    await screen.findByRole('heading', { name: /Hi, rita\.kovac/ })
    expect(
      screen.queryByTestId('dashboard-guest-persist-banner'),
    ).not.toBeInTheDocument()
  })
})
