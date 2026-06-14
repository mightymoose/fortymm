import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router'

import { render, screen, type Container } from '@/test/utilities'

import { Breadcrumb, type BreadcrumbProps } from './breadcrumb'
import { buildBreadcrumbProps } from './breadcrumb.factory'

const scoped = (container: Container) => ({
  /** The current-match label (e.g. "Match abcdef"). Always present once the
   * router resolves. */
  findCurrent(text: string | RegExp) {
    return container.findByText(text)
  },
  /** The "Matches" parent link. */
  queryMatchesLink() {
    return container.queryByRole('link', { name: /^matches$/i })
  },
})

/**
 * Test page-object for `Breadcrumb`. The in-app crumb renders a typed
 * `<Link to="/matches">`, so `render` mounts the component under a minimal
 * memory router that registers that route. The router resolves asynchronously,
 * so tests start with `await breadcrumbPage.findCurrent(...)`.
 */
export const breadcrumbPage = {
  render(overrides: Partial<BreadcrumbProps> = {}) {
    const props = buildBreadcrumbProps(overrides)
    const rootRoute = createRootRoute()
    const indexRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: '/',
      component: () => <Breadcrumb {...props} />,
    })
    // Route stub the "Matches" link navigates to — registered so the typed
    // <Link> resolves at render time.
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
   * `within(node)` subtree. A page object that embeds a `Breadcrumb` (e.g. the
   * match-details page) spreads this to expose the same queries as its own.
   */
  within(container: Container = screen) {
    return scoped(container)
  },

  ...scoped(screen),
}
