import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router'

import { render, screen, within, type Container } from '@/test/utilities'

import {
  GuestPersistBanner,
  type GuestPersistBannerProps,
} from './guest-persist-banner'
import { buildGuestPersistBannerProps } from './guest-persist-banner.factory'

const scoped = (container: Container) => ({
  /** The banner `role="status"` region (carries the legacy testid). */
  getBanner() {
    return container.getByTestId('dashboard-guest-persist-banner')
  },
  queryBanner() {
    return container.queryByTestId('dashboard-guest-persist-banner')
  },
  /** The "Add an email to keep them" conversion link to settings. */
  getCta() {
    return container.getByRole('link', { name: /add an email/i })
  },
  /** The dismiss-for-this-session control. */
  getDismissButton() {
    return container.getByRole('button', { name: /dismiss/i })
  },
})

/**
 * Test page-object for `GuestPersistBanner`. The CTA renders a typed `<Link>`
 * to /settings, so `render` mounts the banner under a minimal memory router.
 * The router resolves asynchronously, so tests start with
 * `await guestPersistBannerPage.findBanner()`. Dismissal persists in
 * `sessionStorage` — clear `GUEST_PERSIST_DISMISS_KEY` in `beforeEach`.
 */
export const guestPersistBannerPage = {
  render(overrides: Partial<GuestPersistBannerProps> = {}) {
    const props = buildGuestPersistBannerProps(overrides)
    const rootRoute = createRootRoute()
    const indexRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: '/',
      component: () => <GuestPersistBanner {...props} />,
    })
    const settingsRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: '/settings',
      component: () => <div>settings</div>,
    })
    const router = createRouter({
      routeTree: rootRoute.addChildren([indexRoute, settingsRoute]),
      history: createMemoryHistory({ initialEntries: ['/'] }),
    })
    render(<RouterProvider router={router} />)
  },

  /** Async-first accessor — the router resolves on first paint. */
  findBanner() {
    return screen.findByTestId('dashboard-guest-persist-banner')
  },

  /** Scope the accessors to a subtree so a parent page object can reuse them. */
  within(node: HTMLElement) {
    return scoped(within(node))
  },

  ...scoped(screen),
}
