import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router'

import { render, screen, type Container } from '@/test/utilities'

import { MatchListRow, type MatchListRowProps } from './match-list-row'
import { buildMatchListRowProps } from './match-list-row.factory'
import { scoreCellPage } from './match-list-row/score-cell.page'
import { statusBadgePage } from './match-list-row/status-badge.page'
import { timeCellPage } from './match-list-row/time-cell.page'

const scoped = (container: Container) => ({
  /** The clickable row itself — a `role="link"` `<tr>` whose accessible name is
   * the composed `aria-label`. Pass the label the row was built with, or omit
   * to use the factory default. */
  getRow(ariaLabel: string = buildMatchListRowProps().row.ariaLabel) {
    return container.getByRole('link', { name: ariaLabel })
  },
  findRow(ariaLabel: string = buildMatchListRowProps().row.ariaLabel) {
    return container.findByRole('link', { name: ariaLabel })
  },
  /** The id cell (`.id-cell`), located by its `M-XXXXXX` short-label text. */
  getIdCell(shortLabel: string = buildMatchListRowProps().row.shortLabel) {
    return container.getByText(shortLabel)
  },
  /** The `.player-name` span for a side, located by its display label. Used for
   * wiring assertions (presence + the winner class); the chip's own internals
   * are pinned by `player-chip.test.tsx`. */
  getPlayerName(name: string) {
    return container.getByText(name)
  },
  /** The trailing action Link (e.g. "Enter score" / "Review result" / "Resolve
   * dispute") — present only when the row's `action` is non-null. Pass the
   * action label the row was built with. */
  getActionLink(label: string) {
    return container.getByRole('link', { name: label })
  },
  queryActionLink(label: string) {
    return container.queryByRole('link', { name: label })
  },
  // Child query surfaces, scoped to the row, for wiring assertions. Each child's
  // internals are pinned by its own tests.
  ...scoreCellPage.within(container),
  ...statusBadgePage.within(container),
  ...timeCellPage.within(container),
})

/**
 * Test page-object for `MatchListRow` — the clickable match table row. The row
 * navigates via the `navigate` prop spy and renders a typed `<Link>` (the
 * trailing "Score" button) plus warms the detail route via `router.preloadRoute`,
 * so `render` mounts it under a minimal memory router that registers stub routes
 * for `/matches/$matchId` and `/matches/$matchId/games/$gameNumber/scores/new`.
 * The router resolves asynchronously, so tests start with
 * `await matchListRowPage.findRow()`.
 *
 * `render` returns the router so a test can spy on `preloadRoute`.
 */
export const matchListRowPage = {
  render(overrides: Partial<MatchListRowProps> = {}) {
    const props = buildMatchListRowProps(overrides)
    const rootRoute = createRootRoute()
    const indexRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: '/',
      component: () => (
        <table>
          <tbody>
            <MatchListRow {...props} />
          </tbody>
        </table>
      ),
    })
    const matchDetail = createRoute({
      getParentRoute: () => rootRoute,
      path: '/matches/$matchId',
      component: () => <div>match-detail</div>,
    })
    const scoringNew = createRoute({
      getParentRoute: () => rootRoute,
      path: '/matches/$matchId/games/$gameNumber/scores/new',
      component: () => <div>scoring-new</div>,
    })
    const router = createRouter({
      routeTree: rootRoute.addChildren([indexRoute, matchDetail, scoringNew]),
      history: createMemoryHistory({ initialEntries: ['/'] }),
    })
    render(<RouterProvider router={router} />)
    return { router }
  },

  /**
   * Scope the accessors to a container — the whole `screen` (default) or a
   * `within(node)` subtree. Parent page objects (the table) spread this to
   * expose the same queries as their own, rather than re-deriving them.
   */
  within(container: Container = screen) {
    return scoped(container)
  },

  ...scoped(screen),
}
