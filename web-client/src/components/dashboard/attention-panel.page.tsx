import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router'

import { render, screen, within, type Container } from '@/test/utilities'

import { AttentionPanel, type AttentionPanelProps } from './attention-panel'
import { buildAttentionPanelProps } from './attention-panel.factory'

const scoped = (container: Container) => ({
  /** The panel `<section>` (absent when there's nothing to surface — the panel
   * hides entirely rather than rendering a standalone empty card). */
  getPanel() {
    return container.getByRole('region', { name: /needs your attention/i })
  },
  /** The panel `<section>`, or null when it has hidden itself. */
  queryPanel() {
    return container.queryByRole('region', { name: /needs your attention/i })
  },
  /** Every action row (one `<li>` per visible item). */
  getRows() {
    return container.getAllByRole('listitem')
  },
  queryRows() {
    return container.queryAllByRole('listitem')
  },
  /** The action button/link in the row whose headline matches `headline`
   * (e.g. "vs nguyen.t"). Resolved by walking up to the row, then querying the
   * link within it — no test-only markup needed. */
  getRowAction(headline: string) {
    const row = container.getByText(headline).closest('li')
    if (!row) throw new Error(`No attention row for "${headline}"`)
    return within(row).getByRole('link')
  },
  /** The calm "all caught up" empty-state copy (absent when rows exist). */
  queryEmptyState() {
    return container.queryByText(/all caught up/i)
  },
  /** The "View all" footer link to /matches. */
  getViewAllLink() {
    return container.getByRole('link', { name: /view all/i })
  },
  /** Footer summary line (overflow / waiting counts), or null when empty. */
  queryFooterText(pattern: RegExp) {
    return container.queryByText(pattern)
  },
})

/**
 * Test page-object for `AttentionPanel`. The rows and footer render typed
 * `<Link>`s (match detail, scoring, /matches), so `render` mounts the panel
 * under a minimal memory router registering those routes. The router resolves
 * asynchronously, so tests start with `await attentionPanelPage.findPanel()`.
 */
export const attentionPanelPage = {
  render(overrides: Partial<AttentionPanelProps> = {}) {
    const props = buildAttentionPanelProps(overrides)
    const rootRoute = createRootRoute()
    const indexRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: '/',
      component: () => <AttentionPanel {...props} />,
    })
    const matchesRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: '/matches',
      component: () => <div>matches</div>,
    })
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
        matchesRoute,
        matchDetailRoute,
        scoringNewRoute,
      ]),
      history: createMemoryHistory({ initialEntries: ['/'] }),
    })
    render(<RouterProvider router={router} />)
  },

  /** Async-first accessor — the router resolves the route tree on first paint,
   * so tests await this before reading the synchronous accessors. */
  findPanel() {
    return screen.findByRole('region', { name: /needs your attention/i })
  },

  /** Scope the accessors to a subtree so a parent page object can expose these
   * queries as its own. */
  within(node: HTMLElement) {
    return scoped(within(node))
  },

  ...scoped(screen),
}
