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
import { http, HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'
import { server } from '@/mocks/server'
import {
  matchListResponse,
  matchListRow,
  sessionResponse,
} from '@/test/factories'
import { Route } from './index'

const MatchesPage = Route.options.component!

function renderMatchesPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  const rootRoute = createRootRoute()
  const matchesRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/matches',
    component: MatchesPage,
  })
  const matchDetailRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/matches/$matchId',
    component: () => {
      const { matchId } = matchDetailRoute.useParams()
      return <div>Match detail {matchId}</div>
    },
  })
  const newMatchRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/matches/new',
    component: () => <div>New match route</div>,
  })
  const scoringRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/matches/$matchId/games/$gameId/scores/new',
    component: () => <div>Scoring</div>,
  })
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      matchesRoute,
      matchDetailRoute,
      newMatchRoute,
      scoringRoute,
    ]),
    history: createMemoryHistory({ initialEntries: ['/matches'] }),
  })
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
}

describe('MatchesPage', () => {
  it('shows skeleton rows while loading, then real rows', async () => {
    renderMatchesPage()

    const skeletonTable = await screen.findByRole('table')
    expect(skeletonTable).toHaveAttribute('aria-busy', 'true')

    expect(await screen.findByText('nguyen.t')).toBeInTheDocument()
    // The aria-busy attribute is dropped (not flipped to "false") once the
    // skeleton table unmounts, so assert on its absence.
    expect(screen.getByRole('table')).not.toHaveAttribute('aria-busy')
    // Seed handler also yields silva.r (final win) and patel.m (final loss).
    expect(screen.getByText('silva.r')).toBeInTheDocument()
    expect(screen.getByText('patel.m')).toBeInTheDocument()
    // The Players column shows both sides — the current mock user (side 1)
    // appears alongside the opponent (side 2).
    expect(screen.getAllByText('rita.kovac').length).toBeGreaterThan(0)
  })

  it('waits for the session before requesting matches (no first-visit 401 race)', async () => {
    const matchRequests: string[] = []
    let releaseSession: (() => void) | null = null
    server.use(
      // Hold the session request open to simulate the cookie not having
      // landed yet on a first-visit direct-load (#144).
      http.get('*/v1/session', async () => {
        await new Promise<void>((resolve) => {
          releaseSession = resolve
        })
        return HttpResponse.json(sessionResponse())
      }),
      http.get('*/v1/matches', ({ request }) => {
        matchRequests.push(request.url)
        return HttpResponse.json(
          matchListResponse({
            items: [matchListRow({ opponent: 'nguyen.t' })],
            total: 1,
            status_counts: { pending: 1 },
          }),
        )
      }),
    )
    renderMatchesPage()

    // While the session is unresolved the query is disabled: the skeleton
    // holds and no matches request is fired (so it can't 401).
    const table = await screen.findByRole('table')
    expect(table).toHaveAttribute('aria-busy', 'true')
    await waitFor(() => expect(releaseSession).not.toBeNull())
    expect(matchRequests).toHaveLength(0)

    // Once the session resolves, the query runs and real rows render.
    releaseSession!()
    expect(await screen.findByText('nguyen.t')).toBeInTheDocument()
    expect(matchRequests.length).toBeGreaterThanOrEqual(1)
  })

  it('paints the winning side green on a completed row', async () => {
    renderMatchesPage()
    // Seed match m-completed-win-1 has side-1 (rita.kovac) winning vs silva.r.
    const winner = await screen.findByText('silva.r')
    // The losing side's name is rendered without is-winner; the winning side
    // (the seed user) on that row carries it.
    const rows = screen.getAllByRole('link')
    const winnerRow = rows.find((r) =>
      r.getAttribute('aria-label')?.includes('silva.r'),
    )
    expect(winnerRow).toBeDefined()
    // The current user on side 1 won this row, so their name carries the
    // winner color.
    const winnerName = winnerRow!.querySelector('.player-name.is-winner')
    expect(winnerName?.textContent).toBe('rita.kovac')
    // And the opponent's name stays neutral.
    expect(winner).not.toHaveClass('is-winner')
  })

  it('passes the API status when the player picks a status tab', async () => {
    const user = userEvent.setup()
    const requests: string[] = []
    server.use(
      http.get('*/v1/matches', ({ request }) => {
        requests.push(request.url)
        return HttpResponse.json(
          matchListResponse({
            items: [matchListRow({ opponent: 'live.opp' })],
            status_counts: { pending: 1, in_progress: 1, completed: 1 },
            total: 1,
          }),
        )
      }),
    )
    renderMatchesPage()

    await waitFor(() => expect(requests.length).toBeGreaterThanOrEqual(1))
    const firstUrl = new URL(requests[0])
    expect(firstUrl.searchParams.get('status')).toBeNull()

    await user.click(screen.getByRole('tab', { name: /live/i }))

    await waitFor(() => {
      const last = new URL(requests[requests.length - 1])
      expect(last.searchParams.get('status')).toBe('in_progress')
    })
  })

  it('keeps the "called" tab disabled with no count', async () => {
    renderMatchesPage()
    const called = await screen.findByRole('tab', { name: /called/i })
    expect(called).toBeDisabled()
    expect(called).toHaveAccessibleName('Called')
  })

  it('moves to the next page when the player clicks Next', async () => {
    const user = userEvent.setup()
    const requests: string[] = []
    server.use(
      http.get('*/v1/matches', ({ request }) => {
        requests.push(request.url)
        const page = Number(new URL(request.url).searchParams.get('page') ?? '1')
        // 26 items total — page 2 exists, so Next activates.
        const items = Array.from({ length: page === 1 ? 25 : 1 }, (_, i) =>
          matchListRow({
            id: `m-${page}-${i}`,
            opponent: `p${page}-${i}`,
          }),
        )
        return HttpResponse.json(
          matchListResponse({
            items,
            total: 26,
            page,
            status_counts: { pending: 26 },
          }),
        )
      }),
    )
    renderMatchesPage()

    await screen.findByText('p1-0')

    await user.click(screen.getByRole('button', { name: /next page/i }))

    await waitFor(() => {
      const last = new URL(requests[requests.length - 1])
      expect(last.searchParams.get('page')).toBe('2')
    })
    await screen.findByText('p2-0')
  })

  it('debounces the search input', async () => {
    const user = userEvent.setup()
    const requests: string[] = []
    server.use(
      http.get('*/v1/matches', ({ request }) => {
        requests.push(request.url)
        return HttpResponse.json(
          matchListResponse({
            items: [matchListRow({ opponent: 'nguyen.t' })],
            total: 1,
            status_counts: { pending: 1 },
          }),
        )
      }),
    )
    renderMatchesPage()
    await waitFor(() => expect(requests.length).toBeGreaterThanOrEqual(1))
    const requestsBeforeTyping = requests.length

    await user.type(screen.getByPlaceholderText(/search players/i), 'ngu')

    await waitFor(
      () => {
        const last = new URL(requests[requests.length - 1])
        expect(last.searchParams.get('q')).toBe('ngu')
      },
      { timeout: 1000 },
    )
    // Three keystrokes should coalesce into one debounced fetch.
    expect(requests.length - requestsBeforeTyping).toBe(1)
  })

  it('renders a single-digit live count, not a zero-padded "00" (#282)', async () => {
    server.use(
      http.get('*/v1/matches', () =>
        HttpResponse.json(
          matchListResponse({
            items: [],
            total: 0,
            status_counts: { in_progress: 0 },
          }),
        ),
      ),
    )
    const { container } = renderMatchesPage()

    // Wait for the load to settle (empty result → empty state).
    await screen.findByText(/no matches yet/i)
    const pill = container.querySelector('.live-pill')
    expect(pill?.textContent?.replace(/\s+/g, ' ').trim()).toBe('0 LIVE')
  })
})
