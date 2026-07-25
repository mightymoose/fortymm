import { render, screen } from '@testing-library/react'
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
import { Route } from './tournaments.$tournamentId'

// The SHIPPED route options — read off the route rather than re-implemented, so a
// route that drops its `params.parse`, its `notFoundComponent` or its
// `errorComponent` reds these tests instead of quietly changing behaviour.
const TournamentRoute = Route.options.component!
const TournamentError = Route.options.errorComponent!
/** The route's OWN not-found boundary (ADR-1001). A route with none of its own has
 * no not-found boundary at its match at all, so the `notFound()` the query (or
 * `params.parse`) throws would escape to TanStack's generic screen — which is
 * exactly what these tests would then render, and go red on. */
const TournamentNotFound = Route.options.notFoundComponent
/** The REAL param parser, typed loosely enough to hang off this harness's route
 * (whose path type differs from the file route's). Nothing here re-implements it —
 * a route that dropped `params.parse` would send `/tournaments/abc` to the API. */
const shippedParseParams = (
  Route.options.params as { parse: (raw: unknown) => { tournamentId: string } }
).parse

/** A well-formed uuid that names nothing — the "valid but unknown" case. */
const UNKNOWN_ID = '00000000-0000-4000-8000-000000000000'

/** Count every detail fetch, so a test can prove one happened — or, for a
 * malformed id, that NONE did (the whole point of validating at the route
 * boundary: a garbage URL never reaches the API). */
function mockDetail(status: number, onRequest?: () => void) {
  server.use(
    http.get('*/v1/tournaments/:id', () => {
      onRequest?.()
      if (status === 200) return HttpResponse.json({ detail: 'unused' })
      return HttpResponse.json({ detail: 'nope' }, { status })
    }),
  )
}

/**
 * Mount the real route at its real path under a memory router, with the shipped
 * boundaries wired, plus a `/tournaments` list stub the not-found page's one
 * recovery link points at. `retryDelay: 1` keeps the 5xx-retry test fast (the
 * query's own `retry` predicate retries a 5xx twice, and it overrides the client).
 */
function renderRoute(initialEntry: string) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retryDelay: 1 } },
  })
  const rootRoute = createRootRoute()
  const detailRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/tournaments/$tournamentId',
    component: TournamentRoute,
    errorComponent: TournamentError,
    notFoundComponent: TournamentNotFound,
    // The REAL param parser — the thing under test. A route that dropped it would
    // send `/tournaments/abc` to the API and blow up in the error boundary.
    params: { parse: (raw) => shippedParseParams(raw) },
  })
  const listRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/tournaments',
    component: () => <div>tournaments list</div>,
  })
  const router = createRouter({
    routeTree: rootRoute.addChildren([listRoute, detailRoute]),
    history: createMemoryHistory({ initialEntries: [initialEntry] }),
  })
  return {
    ...render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    ),
    router,
  }
}

describe('tournament detail route — a missing tournament is a not-found, not an error (ADR-1001)', () => {
  it('sends a MALFORMED id to the designed not-found — with no fetch and no validator string', async () => {
    // The #992 fix: `/tournaments/abc` must never reach the API (where it would
    // 422 with a Pydantic "Input should be a valid UUID" string) — `params.parse`
    // rejects the non-uuid segment and throws `notFound()` before any request.
    let requests = 0
    mockDetail(404, () => {
      requests += 1
    })

    renderRoute('/tournaments/abc')

    expect(
      await screen.findByRole('heading', { name: 'Tournament not found.' }),
    ).toBeInTheDocument()
    // Not a single fetch went out — the boundary caught it at the route edge.
    expect(requests).toBe(0)
    // And the raw validator string never appears.
    expect(screen.queryByText(/valid uuid/i)).not.toBeInTheDocument()
    // Not the error boundary, and not the generic router screen.
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.queryByText(/something went wrong/i)).not.toBeInTheDocument()
  })

  it('sends a well-formed-but-unknown id (a 404) to the same not-found — and this one DID fetch', async () => {
    let requests = 0
    mockDetail(404, () => {
      requests += 1
    })

    renderRoute(`/tournaments/${UNKNOWN_ID}`)

    expect(
      await screen.findByRole('heading', { name: 'Tournament not found.' }),
    ).toBeInTheDocument()
    // The client cannot tell valid-unknown from valid-known without the request —
    // so unlike the malformed case, this one really asked the server. And exactly
    // ONCE: a 404 is terminal, so the query's `retry` predicate declines it rather
    // than making the user watch the skeleton through three attempts.
    expect(requests).toBe(1)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('is not a dead end — the one action lands on the tournaments list', async () => {
    const user = userEvent.setup()
    mockDetail(404)

    const { router } = renderRoute('/tournaments/abc')
    const link = await screen.findByRole('link', { name: 'Back to tournaments' })

    await user.click(link)

    expect(await screen.findByText('tournaments list')).toBeInTheDocument()
    expect(router.state.location.pathname).toBe('/tournaments')
  })

  it('still sends a 5xx to the RETRYABLE error boundary — never “Tournament not found.”', async () => {
    // The regression this change most endangers: a server error is NOT a missing
    // tournament. It must render the error state, with a working retry, and must
    // never be reported as a 404.
    let requests = 0
    mockDetail(500, () => {
      requests += 1
    })

    renderRoute(`/tournaments/${UNKNOWN_ID}`)

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Couldn’t load this tournament.')
    expect(
      screen.queryByRole('heading', { name: 'Tournament not found.' }),
    ).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument()
    // …and, unlike the 404, a 5xx is retried before it gives up (the query's
    // predicate retries a transient server failure a couple of times).
    expect(requests).toBeGreaterThan(1)
  })

  it('sends a 403 to the AccessDenied panel, not the not-found', async () => {
    // A permitted non-creator the server still gates. It used to reach the parent
    // layout's `RbacBoundary`; the route's own error boundary now catches it first
    // and renders the same panel.
    mockDetail(403)

    renderRoute(`/tournaments/${UNKNOWN_ID}`)

    expect(
      await screen.findByText("You don't have access to this page"),
    ).toBeInTheDocument()
    expect(
      screen.queryByRole('heading', { name: 'Tournament not found.' }),
    ).not.toBeInTheDocument()
  })
})
