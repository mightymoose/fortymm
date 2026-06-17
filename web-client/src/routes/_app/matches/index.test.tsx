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

function renderMatchesPage(initialEntry = '/matches') {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  const rootRoute = createRootRoute()
  const matchesRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/matches',
    component: MatchesPage,
    validateSearch: Route.options.validateSearch,
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
    history: createMemoryHistory({ initialEntries: [initialEntry] }),
  })
  return { router, ...render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  ) }
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

  it('no longer renders the disabled "Called" tab or coming-soon filters (#149)', async () => {
    renderMatchesPage()
    await screen.findByRole('tab', { name: /up next/i })
    expect(screen.queryByRole('tab', { name: /called/i })).not.toBeInTheDocument()
    expect(screen.queryByText(/all contexts/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/all rounds/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/all courts/i)).not.toBeInTheDocument()
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

  it('hydrates filters from the URL on load (deep-link)', async () => {
    const requests: string[] = []
    server.use(
      http.get('*/v1/matches', ({ request }) => {
        requests.push(request.url)
        return HttpResponse.json(
          matchListResponse({
            items: [matchListRow({ opponent: 'nguyen.t' })],
            // Enough total for page 2 to be in range, so the deep-linked page
            // isn't snapped back by the out-of-range clamp (#541).
            total: 50,
            page: 2,
            status_counts: { in_progress: 1 },
          }),
        )
      }),
    )
    renderMatchesPage('/matches?q=ngu&status=live&page=2')

    // The first fetch already carries the URL filters — no debounce delay
    // on initial load because the params are the same value across renders.
    await waitFor(() => expect(requests.length).toBeGreaterThanOrEqual(1))
    const url = new URL(requests[requests.length - 1])
    expect(url.searchParams.get('q')).toBe('ngu')
    expect(url.searchParams.get('status')).toBe('in_progress')
    expect(url.searchParams.get('page')).toBe('2')

    // The search input reflects the URL value.
    expect(screen.getByPlaceholderText(/search players/i)).toHaveValue('ngu')
  })

  it('shrugs off garbage search params via zod fallback', async () => {
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
    // ?status=garbage and ?page=NaN should not crash — both fall back to
    // defaults and the page renders as if no filter were set.
    renderMatchesPage('/matches?status=garbage&page=NaN')

    await waitFor(() => expect(requests.length).toBeGreaterThanOrEqual(1))
    const url = new URL(requests[0])
    expect(url.searchParams.get('status')).toBeNull()
    expect(url.searchParams.get('page')).toBe('1')
  })

  it('writes filter changes to the URL immediately, before the debounced fetch fires', async () => {
    const user = userEvent.setup()
    server.use(
      http.get('*/v1/matches', () =>
        HttpResponse.json(
          matchListResponse({
            items: [matchListRow({ opponent: 'nguyen.t' })],
            total: 1,
            status_counts: { pending: 1 },
          }),
        ),
      ),
    )
    const { router } = renderMatchesPage()
    await screen.findByText('nguyen.t')

    await user.type(screen.getByPlaceholderText(/search players/i), 'ngu')

    // URL reflects every keystroke — no debounce on the persistence side.
    await waitFor(() => {
      expect(router.state.location.search).toEqual(
        expect.objectContaining({ q: 'ngu' }),
      )
    })
  })

  it('reads a non-"all" status tab with no results as filtered, not a cold start (#373)', async () => {
    // A status tab that filters everything out is NOT a first-run user — the
    // empty state must offer Clear filters and not imply "No matches yet".
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
    renderMatchesPage('/matches?status=live')

    expect(
      await screen.findByText(/no matches match your filters/i),
    ).toBeInTheDocument()
    expect(screen.queryByText(/^no matches yet$/i)).not.toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: /clear filters/i }),
    ).toBeInTheDocument()
  })

  it('reads an out-of-range ?page= no-result frame as filtered, not a cold start (#373)', async () => {
    // The clamp (#541) snaps the page back asynchronously; until it does, the
    // out-of-range page paints an empty table. That frame must read as filtered
    // ("No matches match your filters" + Clear filters) — `page > totalPages`
    // feeds `isFiltered` — so it never flashes the cold-start "No matches yet".
    server.use(
      http.get('*/v1/matches', ({ request }) => {
        const page = Number(
          new URL(request.url).searchParams.get('page') ?? '1',
        )
        // 16 matches → one page. page=2 is out of range and returns no items,
        // but the real total is still reported (so totalPages stays 1).
        const items = page === 1 ? [matchListRow({ opponent: 'nguyen.t' })] : []
        return HttpResponse.json(
          matchListResponse({
            items,
            total: 16,
            page,
            status_counts: { pending: 16 },
          }),
        )
      }),
    )
    renderMatchesPage('/matches?page=2')

    // The out-of-range frame reads as filtered ("No matches match your
    // filters"), not the cold-start "No matches yet" — proving `page >
    // totalPages` feeds `isFiltered`. (The clamp then recovers the page; that
    // recovery is asserted by the #541 test below.)
    expect(
      await screen.findByText(/no matches match your filters/i),
    ).toBeInTheDocument()
  })

  it('snaps an out-of-range ?page= back to the last valid page (#541)', async () => {
    server.use(
      http.get('*/v1/matches', ({ request }) => {
        const page = Number(new URL(request.url).searchParams.get('page') ?? '1')
        // 16 matches → a single page. Any page > 1 is out of range and the
        // API returns no items (but still the real total).
        const items =
          page === 1 ? [matchListRow({ opponent: 'nguyen.t' })] : []
        return HttpResponse.json(
          matchListResponse({ items, total: 16, page, status_counts: { pending: 16 } }),
        )
      }),
    )
    const { router } = renderMatchesPage('/matches?page=2')

    // The page redirects to the last valid page, so the real rows render
    // rather than an empty table under a broken "Showing 26–16" footer.
    expect(await screen.findByText('nguyen.t')).toBeInTheDocument()
    await waitFor(() => {
      expect(router.state.location.search).not.toEqual(
        expect.objectContaining({ page: 2 }),
      )
    })
    // The footer range is sane — start never exceeds end.
    expect(screen.getByText(/showing/i).textContent).toContain('1–16')
    expect(screen.queryByText(/26–16/)).not.toBeInTheDocument()
  })

  it('Export CSV links straight to /v1/matches.csv with the active filter (#149)', async () => {
    const user = userEvent.setup()
    server.use(
      http.get('*/v1/matches', () =>
        HttpResponse.json(
          matchListResponse({
            items: [matchListRow({ opponent: 'nguyen.t' })],
            total: 1,
            status_counts: { completed: 1 },
          }),
        ),
      ),
    )
    renderMatchesPage()
    await screen.findByText('nguyen.t')
    // Narrow to the Final filter — the export link must carry it.
    await user.click(screen.getByRole('tab', { name: /final/i }))

    const link = screen.getByRole('link', { name: /export csv/i })
    const href = link.getAttribute('href') ?? ''
    expect(href).toContain('/v1/matches.csv')
    expect(href).toContain('status=completed')
    // A real download link — the browser fetches the file directly.
    expect(link).toHaveAttribute('download')
  })
})
