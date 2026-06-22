import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router'

import { render, screen, type Container } from '@/test/utilities'

import { PageTitle, type PageTitleProps } from './page-title'
import { buildPageTitleProps } from './page-title.factory'

const scoped = (container: Container) => ({
  /** The greeting heading (the trailing accent period is part of its name). */
  getHeading(name: string | RegExp) {
    return container.getByRole('heading', { name })
  },
  /** The greeting placeholder bar shown while the session is in flight, or
   * null once it has resolved. The heading keeps its `role` and gains an
   * `aria-busy`/`aria-label` while loading (mirroring `UserMenu`). */
  queryGreetingSkeleton() {
    return container.queryByRole('heading', { name: /loading greeting/i })
  },
  /** The optional subtitle line, or null when none was supplied. */
  querySubtitle(text: string | RegExp) {
    return container.queryByText(text)
  },
  /** The "Log a match" action — a typed `<Link>` to /matches/new. */
  getLogMatchLink() {
    return container.getByRole('link', { name: /log a match/i })
  },
})

/**
 * Test page-object for `PageTitle`. The "Log a match" Button renders a typed
 * `<Link>`, so `render` mounts the title under a minimal memory router
 * registering `/matches/new` (and `/`). The router resolves asynchronously, so
 * tests start with `await pageTitlePage.findHeading(...)`.
 */
export const pageTitlePage = {
  render(overrides: Partial<PageTitleProps> = {}) {
    const props = buildPageTitleProps(overrides)
    const rootRoute = createRootRoute()
    const indexRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: '/',
      component: () => <PageTitle {...props} />,
    })
    const matchesNewRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: '/matches/new',
      component: () => <div>matches-new</div>,
    })
    const router = createRouter({
      routeTree: rootRoute.addChildren([indexRoute, matchesNewRoute]),
      history: createMemoryHistory({ initialEntries: ['/'] }),
    })
    render(<RouterProvider router={router} />)
  },

  /** Async-first accessor — the router resolves the route tree on first paint,
   * so tests await this before reading the synchronous accessors. */
  findHeading(name: string | RegExp) {
    return screen.findByRole('heading', { name })
  },

  within(container: Container = screen) {
    return scoped(container)
  },

  ...scoped(screen),
}
