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
import { matchListResponse, matchListRow } from '@/test/factories'
import { Route } from './index'

// Route files only export `Route`; pull the component off it to mount.
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
    // The default MSW handler serves seeded matches, which are enough to
    // prove the loading → loaded transition.
    renderMatchesPage()

    const skeletonTable = await screen.findByRole('table')
    expect(skeletonTable).toHaveAttribute('aria-busy', 'true')

    // Once the request resolves the seeded `nguyen.t` opponent shows up.
    expect(await screen.findByText('nguyen.t')).toBeInTheDocument()
    expect(screen.getByRole('table')).not.toHaveAttribute('aria-busy', 'true')
  })

  it('passes the API status when the player picks a status tab', async () => {
    const user = userEvent.setup()
    const requests: string[] = []
    server.use(
      http.get('*/v1/matches', ({ request }) => {
        requests.push(request.url)
        return HttpResponse.json(
          matchListResponse({
            items: [matchListRow({ opponent_username: 'live.opp' })],
            status_counts: { pending: 1, in_progress: 1, completed: 1 },
            total: 1,
          }),
        )
      }),
    )
    renderMatchesPage()

    // Wait for the first (status=all) request to land.
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
    // The tab renders no badge, so the only digits in its label come from
    // accidentally-included counts. There should be none.
    expect(called.textContent?.trim()).toBe('Called')
  })

  it('moves to the next page when the player clicks Next', async () => {
    const user = userEvent.setup()
    const requests: string[] = []
    server.use(
      http.get('*/v1/matches', ({ request }) => {
        requests.push(request.url)
        const page = Number(new URL(request.url).searchParams.get('page') ?? '1')
        // 26 items total, so page 2 exists and the Next button activates.
        const items = Array.from({ length: page === 1 ? 25 : 1 }, (_, i) =>
          matchListRow({
            id: `m-${page}-${i}`,
            opponent_username: `p${page}-${i}`,
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
            items: [matchListRow({ opponent_username: 'nguyen.t' })],
            total: 1,
            status_counts: { pending: 1 },
          }),
        )
      }),
    )
    renderMatchesPage()
    await waitFor(() => expect(requests.length).toBeGreaterThanOrEqual(1))
    const requestsBeforeTyping = requests.length

    // Three keystrokes in quick succession should coalesce into one request
    // after the debounce window, not three.
    await user.type(screen.getByPlaceholderText(/search opponents/i), 'ngu')

    await waitFor(
      () => {
        const last = new URL(requests[requests.length - 1])
        expect(last.searchParams.get('q')).toBe('ngu')
      },
      { timeout: 1000 },
    )
    // One request for the final settled term, not one per keystroke.
    expect(requests.length - requestsBeforeTyping).toBeLessThanOrEqual(2)
  })

  it('renders the seeded matches end-to-end against MSW', async () => {
    renderMatchesPage()

    // The default MSW seeds include nguyen.t (live), silva.r (final win),
    // patel.m (final loss). All three should render in the initial page.
    expect(await screen.findByText('nguyen.t')).toBeInTheDocument()
    expect(screen.getByText('silva.r')).toBeInTheDocument()
    expect(screen.getByText('patel.m')).toBeInTheDocument()
  })
})
