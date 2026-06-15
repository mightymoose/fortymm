import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router'

import { render, screen, within, type Container } from '@/test/utilities'

import { DashboardHeader, type DashboardHeaderProps } from './dashboard-header'
import { buildDashboardHeaderProps } from './dashboard-header.factory'

const scoped = (container: Container) => ({
  /** The greeting headline (`<h1>`), e.g. "Hi, @rita.kovac". */
  getGreeting() {
    return container.getByRole('heading', { level: 1 })
  },
  /** The "Log a match" action link to /matches/new. */
  getLogMatchLink() {
    return container.getByRole('link', { name: /log a match/i })
  },
})

/**
 * Test page-object for `DashboardHeader`. The action renders a typed `<Link>`
 * to /matches/new, so `render` mounts the header under a minimal memory router
 * registering that route. The router resolves asynchronously, so tests start
 * with `await dashboardHeaderPage.findGreeting()`.
 */
export const dashboardHeaderPage = {
  render(overrides: Partial<DashboardHeaderProps> = {}) {
    const props = buildDashboardHeaderProps(overrides)
    const rootRoute = createRootRoute()
    const indexRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: '/',
      component: () => <DashboardHeader {...props} />,
    })
    const newMatchRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: '/matches/new',
      component: () => <div>new-match</div>,
    })
    const router = createRouter({
      routeTree: rootRoute.addChildren([indexRoute, newMatchRoute]),
      history: createMemoryHistory({ initialEntries: ['/'] }),
    })
    render(<RouterProvider router={router} />)
  },

  /** Async-first accessor — the router resolves the route tree on first paint,
   * so tests await this before reading the synchronous accessors. */
  findGreeting() {
    return screen.findByRole('heading', { level: 1 })
  },

  /** Scope the accessors to a subtree so a parent page object can expose these
   * queries as its own. */
  within(node: HTMLElement) {
    return scoped(within(node))
  },

  ...scoped(screen),
}
