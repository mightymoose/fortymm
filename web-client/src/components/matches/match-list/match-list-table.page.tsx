import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router'

import { render, screen, within, type Container } from '@/test/utilities'

import { MatchListTable, type MatchListTableProps } from './match-list-table'
import { buildMatchListTableProps } from './match-list-table.factory'
import { matchListTableHeadPage } from './match-list-table/match-list-table-head.page'
import { matchListRowPage } from './match-list-table/match-list-row.page'

const scoped = (container: Container) => ({
  /** The rendered `<table>` (settled or skeleton). The skeleton table carries
   * `aria-busy`; the settled table does not. Absent in the empty state. */
  getTable() {
    return container.getByRole('table')
  },
  /** The empty-state copy heading, present only when not loading and no rows.
   * Matches either copy — the cold-start "No matches yet" or the filtered
   * "No matches match your filters". */
  getEmptyState() {
    return container.getByText(/no matches (yet|match your filters)/i)
  },
  queryEmptyState() {
    return container.queryByText(/no matches (yet|match your filters)/i)
  },
  /** The cold-start (unfiltered) heading specifically. */
  queryColdStartHeading() {
    return container.queryByText(/^no matches yet$/i)
  },
  /** The filtered no-result heading specifically. */
  queryFilteredHeading() {
    return container.queryByText(/no matches match your filters/i)
  },
  /** The empty-state "Clear filters" button (filtered empty only). */
  getClearFiltersButton() {
    return container.getByRole('button', { name: /clear filters/i })
  },
  /** Nullable variant — the cold-start empty omits the Clear filters button. */
  queryClearFiltersButton() {
    return container.queryByRole('button', { name: /clear filters/i })
  },
  // Column headers (Match/Players/Score/Status/Started) read as this table's
  // own queries.
  ...matchListTableHeadPage.within(container),
  /** The MatchListRow query surface, scoped to this table — reuse the row's own
   * accessors (e.g. `rows.getRow(ariaLabel)`) rather than re-deriving them. */
  rows: matchListRowPage.within(container),
})

/**
 * Test page-object for `MatchListTable` — the matches `<table>` (head + body of
 * rows), its loading skeleton, and its empty state. Each `MatchListRow` renders
 * typed `<Link>`s (the row navigates to match details and links the Score
 * button), so `render` mounts the table under a minimal memory router that
 * registers those routes — the same harness `MatchListRow` uses. The router
 * resolves asynchronously, so tests start with `await matchListTablePage.find...()`.
 *
 * The skeleton table carries `aria-busy`; the settled table does not.
 */
export const matchListTablePage = {
  render(overrides: Partial<MatchListTableProps> = {}) {
    const props = buildMatchListTableProps(overrides)
    const rootRoute = createRootRoute()
    const indexRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: '/',
      component: () => <MatchListTable {...props} />,
    })
    // Route stubs the rows' typed <Link>s navigate to — registered so they
    // resolve at render time.
    const matchDetailRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: '/matches/$matchId',
      component: () => <div>match-detail</div>,
    })
    const scoringNewRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: '/matches/$matchId/games/$gameNumber/scores/new',
      component: () => <div>scoring-new</div>,
    })
    const router = createRouter({
      routeTree: rootRoute.addChildren([
        indexRoute,
        matchDetailRoute,
        scoringNewRoute,
      ]),
      history: createMemoryHistory({ initialEntries: ['/'] }),
    })
    render(<RouterProvider router={router} />)
  },

  /**
   * The async-first accessor — the router resolves the route tree on the first
   * paint, so tests await this before reading the synchronous accessors.
   */
  findTable() {
    return screen.findByRole('table')
  },

  /** Async-first accessor for the empty state — no `<table>` renders, so tests
   * await this instead of `findTable()` before reading synchronous accessors. */
  findEmptyState() {
    return screen.findByText(/no matches (yet|match your filters)/i)
  },

  /**
   * Scope the accessors to a subtree. Pass the embedding element so a parent
   * page object exposes these queries as its own — both the role/name queries
   * and the row surface (which needs an `HTMLElement` root) scope to the node.
   */
  within(node: HTMLElement) {
    return scoped(within(node))
  },

  ...scoped(screen),
}
