import { Suspense } from 'react'
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  useSearch,
} from '@tanstack/react-router'
import { zodValidator } from '@tanstack/zod-adapter'
import { http, HttpResponse } from 'msw'
import userEvent from '@testing-library/user-event'

import type { components } from '@/api/schema'
import { RbacBoundary } from '@/components/rbac/error-fallback'
import { pageAdminScheduleSolves } from '@/mocks/factories/tournaments/tournament.factory'
import { server } from '@/mocks/server'
import { render, screen, within as rtlWithin, type Container } from '@/test/utilities'

import { solveLedgerSearchSchema } from './queries'
import { SolveLedgerPage, SolveLedgerSkeleton } from './solve-ledger-page'
import { buildLedgerVariety } from './solve-ledger-page.factory'

type AdminScheduleSolveRead = components['schemas']['AdminScheduleSolveRead']

const scoped = (container: Container) => ({
  /** A run's row, by the seed's id. */
  findRow(id: string) {
    return container.findByTestId(`solve-row-${id}`)
  },
  queryRow(id: string) {
    return container.queryByTestId(`solve-row-${id}`)
  },
  /** The failure expansion under a run's row (only failed/infeasible rows have
   * one, and only while it is open). */
  queryDetail(id: string) {
    return container.queryByTestId(`solve-detail-${id}`)
  },
  /** The tournament filter chip above the table. */
  queryFilterChip() {
    return container.queryByTestId('tournament-filter-chip')
  },
  /** The footer's "Showing 1–25 of 34 runs" readout. */
  findReadout(text: RegExp) {
    return container.findByText(text)
  },
  /** The designed access-denied panel the admin boundary renders on a 403. */
  findAccessDenied() {
    return container.findByText("You don't have access to this page")
  },
})

/**
 * Test page-object for the admin `SolveLedgerPage`.
 *
 * `render` mounts the page under a memory router whose `/admin/schedule-solves`
 * route re-creates the real route's boundary structure — the search parsed by
 * the SAME `solveLedgerSearchSchema` the route file uses, the admin layout's
 * `RbacBoundary` above it, and a `Suspense` fallback of the real skeleton — so
 * URL round-trips, the 403 designed state and the suspense hand-off are all
 * exercised the way the shipped route wires them. The endpoint is served by
 * MSW through the same `pageAdminScheduleSolves` helper the dev world and the
 * e2e stubs use.
 */
export const solveLedgerPage = {
  /** Point MSW at `rows` (paged + filtered exactly as the API pages). */
  install(rows: AdminScheduleSolveRead[]) {
    server.use(
      http.get('*/v1/admin/schedule-solves', ({ request }) => {
        const url = new URL(request.url)
        return HttpResponse.json(
          pageAdminScheduleSolves(rows, {
            tournament_id: url.searchParams.get('tournament_id'),
            page: Number(url.searchParams.get('page') ?? '1'),
            page_size: Number(url.searchParams.get('page_size') ?? '25'),
          }),
        )
      }),
    )
  },

  /** Answer the endpoint with a permission 403 — the server-side
   * `scheduling.view` gate, raw FastAPI detail and all. */
  installForbidden() {
    server.use(
      http.get('*/v1/admin/schedule-solves', () =>
        HttpResponse.json(
          { detail: 'Missing permission: scheduling.view' },
          { status: 403 },
        ),
      ),
    )
  },

  /** Mount at `path` (a full URL-with-search, so deep links are first-class). */
  mount(path = '/admin/schedule-solves') {
    // Defined inside the page object (not at module level) so this test-only
    // file keeps a single non-component export shape (react-refresh rule).
    const LedgerRouteComponent = () => {
      const search = useSearch({ strict: false }) as {
        page?: number
        tournament?: string
      }
      return (
        <SolveLedgerPage page={search.page ?? 1} tournamentId={search.tournament} />
      )
    }
    const rootRoute = createRootRoute({
      component: () => (
        <RbacBoundary>
          <Suspense fallback={<SolveLedgerSkeleton />}>
            <Outlet />
          </Suspense>
        </RbacBoundary>
      ),
    })
    const ledgerRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: '/admin/schedule-solves',
      validateSearch: zodValidator(solveLedgerSearchSchema),
      component: LedgerRouteComponent,
    })
    // The row links target the tournament detail route; register a stub so the
    // typed `<Link>`s resolve.
    const tournamentRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: '/tournaments/$tournamentId',
      component: () => <div data-testid="tournament-detail-stub" />,
    })
    const router = createRouter({
      routeTree: rootRoute.addChildren([ledgerRoute, tournamentRoute]),
      history: createMemoryHistory({ initialEntries: [path] }),
    })
    render(<RouterProvider router={router} />)
    return router
  },

  /** The common case: seed rows, mount, hand back the router for URL asserts. */
  render(rows: AdminScheduleSolveRead[] = buildLedgerVariety(), path?: string) {
    this.install(rows)
    return this.mount(path)
  },

  user() {
    return userEvent.setup()
  },

  within(node?: HTMLElement) {
    return scoped(node ? rtlWithin(node) : screen)
  },

  ...scoped(screen),
}
