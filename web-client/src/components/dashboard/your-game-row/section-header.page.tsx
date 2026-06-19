import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router'

import { render, screen, type Container } from '@/test/utilities'

import { SectionHeader, type SectionHeaderProps } from './section-header'
import { buildSectionHeaderProps } from './section-header.factory'

const scoped = (container: Container) => ({
  /** The section's `<h2>` heading carrying `title`. */
  getHeading(title: string | RegExp) {
    return container.getByRole('heading', { name: title })
  },
  /** Async-first heading accessor — the router resolves on first paint. */
  findHeading(title: string | RegExp) {
    return container.findByRole('heading', { name: title })
  },
  /** The muted subtitle span, or null when none was given. */
  querySubtitle(text: string | RegExp) {
    return container.queryByText(text)
  },
  /** The action link with accessible name `name`. */
  getActionLink(name: string | RegExp) {
    return container.getByRole('link', { name })
  },
  /** Async-first action-link accessor for router resolution. */
  findActionLink(name: string | RegExp) {
    return container.findByRole('link', { name })
  },
  /** The action link, or null when no action/actionTo was supplied. */
  queryActionLink() {
    return container.queryByRole('link')
  },
})

/**
 * Test page-object for `SectionHeader`. The optional action renders a typed
 * `<Link>`, so `render` always mounts the header under a minimal memory router
 * registering '/' and '/matches' (the only `actionTo` values in use) — that way
 * both the link and the no-link branches resolve. The router resolves
 * asynchronously, so link/heading reads use the `find*` accessors.
 */
export const sectionHeaderPage = {
  render(overrides: Partial<SectionHeaderProps> = {}) {
    const props = buildSectionHeaderProps(overrides)
    const rootRoute = createRootRoute()
    const indexRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: '/',
      component: () => <SectionHeader {...props} />,
    })
    const matchesRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: '/matches',
      component: () => <div>matches</div>,
    })
    const router = createRouter({
      routeTree: rootRoute.addChildren([indexRoute, matchesRoute]),
      history: createMemoryHistory({ initialEntries: ['/'] }),
    })
    render(<RouterProvider router={router} />)
  },

  /** Scope the accessors to a container — the whole `screen` (default) or a
   * `within(node)` subtree — so an owner page object can expose these queries
   * as its own. */
  within(container: Container = screen) {
    return scoped(container)
  },

  ...scoped(screen),
}
