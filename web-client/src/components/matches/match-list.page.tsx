import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router'
import { zodValidator } from '@tanstack/zod-adapter'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { http, HttpResponse } from 'msw'

import { render, screen, within, type Container } from '@/test/utilities'
import { server } from '@/mocks/server'
import { sessionResponse } from '@/test/factories'
import type { MatchListResponse } from '@/api/matches'

import { MatchList } from './match-list'
import { matchesSearchSchema } from './match-list/match-list-status'
import { actionBarPage } from './match-list/action-bar.page'
import { filterRowPage } from './match-list/filter-row.page'
import { matchListTablePage } from './match-list/match-list-table.page'
import { paginationFooterPage } from './match-list/pagination-footer.page'

const scoped = (container: Container, root: HTMLElement) => ({
  // Compose each child's query surface so wiring tests can assert against the
  // child regions without re-deriving their accessors — the shell is observed
  // through its children being present. Leaf branches are pinned by each
  // child's own test. The table's `within` takes an HTMLElement root (it scopes
  // the row surface to a node), so thread `root` to it.
  actionBar: actionBarPage.within(container),
  filterRow: filterRowPage.within(container),
  table: matchListTablePage.within(root),
  footer: paginationFooterPage.within(container),
})

/**
 * Test page-object for `MatchList` — the /matches page orchestrator. The
 * heavy behavioral coverage stays in `src/routes/matches/index.test.tsx`
 * (against the thin route); this surface verifies the wiring of the four
 * presentational children into the shell.
 *
 * `MatchList` renders typed `<Link>`s (and reads URL search) so `render`
 * mounts it under a minimal memory router that registers `/matches` (with the
 * real `matchesSearchSchema` validator) plus stubs for every link target the
 * subtree navigates to. The router resolves asynchronously and the BFF query
 * is async, so tests start with `await matchListPage.find...()`.
 */
export const matchListPage = {
  /** Stub `/v1/matches` for this test. Pass a typed `MatchListResponse`
   * payload (built with `matchListResponse(...)`). */
  mockEndpoint(payload: MatchListResponse) {
    server.use(
      http.get('*/v1/matches', () => HttpResponse.json(payload)),
    )
  },

  /** Stub `/v1/session` so the session-gated query is enabled immediately. */
  mockSession() {
    server.use(
      http.get('*/v1/session', () => HttpResponse.json(sessionResponse())),
    )
  },

  /**
   * Async-first accessor: resolve once a settled row paints (router + BFF query
   * resolved). Find a row by its composed `aria-label`, e.g.
   * `'Open match: rita.kovac vs nguyen.t'`. Tests await this before reading the
   * synchronous child accessors.
   */
  findRow(ariaLabel: string) {
    return screen.findByRole('link', { name: ariaLabel })
  },

  /**
   * Render `MatchList` under the memory-router + QueryClient harness.
   * `initialEntry` deep-links the URL (filters live in the search string).
   */
  render(initialEntry = '/matches') {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    const rootRoute = createRootRoute()
    const matchesRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: '/matches',
      component: () => <MatchList />,
      validateSearch: zodValidator(matchesSearchSchema),
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
      path: '/matches/$matchId/games/$gameNumber/scores/new',
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
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    )
  },

  /**
   * Scope the accessors to a subtree. Pass the embedding element so a parent
   * page object exposes these queries as its own — both the role/name child
   * surfaces and the table surface (which needs an `HTMLElement` root) scope to
   * the node.
   */
  within(node: HTMLElement) {
    return scoped(within(node), node)
  },

  ...scoped(screen, document.body),
}
