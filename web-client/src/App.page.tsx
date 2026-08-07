import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRouter,
} from '@tanstack/react-router'

import { render, screen, type Container } from '@/test/utilities'

import App from './App'

const scoped = (container: Container) => ({
  /**
   * The landing page's iOS call to action, in the CTA band above the footer.
   * A `link` role, deliberately: it points at the public TestFlight beta, so
   * an `aria-disabled` span here would be a failure, not a match.
   */
  getIosAppLink() {
    return container.getByRole('link', { name: 'Get the iOS app' })
  },
  /**
   * The Android call to action beside it. Android does not exist yet, so this
   * is inert text with `aria-disabled` — there is no link to find, which is
   * why the accessor reads the element rather than a role.
   */
  getAndroidAppCta() {
    return container.getByText('Get the Android app')
  },
})

/**
 * Test page-object for the logged-out landing page (`App`, the `/` route).
 *
 * `App` renders TanStack `<Link>`s, so `render()` mounts it under a memory
 * router seeded at `/` — the same context it has in production. The router
 * resolves on a tick, so tests start with an `await` (a `find*` query, or the
 * `findByRole` the hero test uses) before reading anything synchronously.
 */
export const appPage = {
  render() {
    const router = createRouter({
      routeTree: createRootRoute({ component: App }),
      history: createMemoryHistory({ initialEntries: ['/'] }),
    })
    render(<RouterProvider router={router} />)
  },

  /** Scope the accessors to a container — the whole `screen` by default. */
  within(container: Container = screen) {
    return scoped(container)
  },

  ...scoped(screen),
}
