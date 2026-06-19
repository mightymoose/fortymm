import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router'

import { render, screen, type Container } from '@/test/utilities'

import { Button, type ButtonProps } from './button'
import { buildButtonProps } from './button.factory'

const scoped = (container: Container) => ({
  /** The link rendered when `to` is set, resolved by its accessible name. */
  getLink(name: string | RegExp) {
    return container.getByRole('link', { name })
  },
  /** The plain `<button>` rendered when `to` is omitted. */
  getButton(name: string | RegExp) {
    return container.getByRole('button', { name })
  },
})

/**
 * Test page-object for `Button`. The default factory sets `to`, so the button
 * renders a typed `<Link>`; `render` mounts it under a minimal memory router
 * registering the link target (and `/`). The router resolves asynchronously,
 * so tests for the link case start with `await buttonPage.findLink(name)`.
 */
export const buttonPage = {
  render(overrides: Partial<ButtonProps> = {}) {
    const props = buildButtonProps(overrides)
    const rootRoute = createRootRoute()
    const indexRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: '/',
      component: () => <Button {...props} />,
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
   * so tests await this before reading the synchronous link accessors. */
  findLink(name: string | RegExp) {
    return screen.findByRole('link', { name })
  },

  /** Async-first accessor for the `<button>` case (no `to`), since the router
   * still resolves the route tree asynchronously on first paint. */
  findButton(name: string | RegExp) {
    return screen.findByRole('button', { name })
  },

  /** Scope the accessors to a container — the whole `screen` (default) or a
   * `within(node)` subtree — so a parent page object can expose these queries
   * as its own. */
  within(container: Container = screen) {
    return scoped(container)
  },

  ...scoped(screen),
}
