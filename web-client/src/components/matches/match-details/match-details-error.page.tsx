import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router'

import { render, screen, type Container } from '@/test/utilities'

import {
  MatchDetailsError,
  type MatchDetailsErrorProps,
} from './match-details-error'
import { buildMatchDetailsErrorProps } from './match-details-error.factory'

const scoped = (container: Container) => ({
  /** The error region. Always present once the boundary renders. */
  findAlert() {
    return container.findByRole('alert')
  },
  /** The headline copy (e.g. "We couldn't find that match."). Use a
   * substring/regex matcher; absent only if the alert hasn't rendered. */
  queryMessage(text: string | RegExp) {
    return container.queryByText(text)
  },
  /** The retry affordance — present for retryable errors (429, 5xx, network),
   * absent for the not-found dead end. */
  queryRetryButton() {
    return container.queryByRole('button', { name: /try again/i })
  },
  /** The "Back to matches" link — present only for the in-app not-found case
   * (4xx, non-standalone); absent on the public standalone route. */
  queryBackLink() {
    return container.queryByRole('link', { name: /back to matches/i })
  },
})

/**
 * Test page-object for `MatchDetailsError`. The not-found case renders a typed
 * `<Link to="/matches">`, so `render` mounts the component under a minimal
 * memory router that registers that route. The router resolves asynchronously,
 * so tests start with `await matchDetailsErrorPage.findAlert()`.
 */
export const matchDetailsErrorPage = {
  render(overrides: Partial<MatchDetailsErrorProps> = {}) {
    const props = buildMatchDetailsErrorProps(overrides)
    const rootRoute = createRootRoute()
    const indexRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: '/',
      component: () => <MatchDetailsError {...props} />,
    })
    // Route stub the "Back to matches" link navigates to — registered so the
    // typed <Link> resolves at render time.
    const matchesList = createRoute({
      getParentRoute: () => rootRoute,
      path: '/matches',
      component: () => <div>matches-list</div>,
    })
    const router = createRouter({
      routeTree: rootRoute.addChildren([indexRoute, matchesList]),
      history: createMemoryHistory({ initialEntries: ['/'] }),
    })
    render(<RouterProvider router={router} />)
  },

  /**
   * Scope the accessors to a container — the whole `screen` (default) or a
   * `within(node)` subtree. Parent page objects spread this to expose the same
   * queries as their own rather than re-deriving them.
   */
  within(container: Container = screen) {
    return scoped(container)
  },

  ...scoped(screen),
}
