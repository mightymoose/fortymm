import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router'

import { render, screen, type Container } from '@/test/utilities'

import {
  ChannelSetupNudge,
  type ChannelSetupNudgeProps,
} from './channel-setup-nudge'
import { buildChannelSetupNudgeProps } from './channel-setup-nudge.factory'

const scoped = (container: Container) => ({
  /** The nudge container (a status-role Alert). */
  get() {
    return container.getByRole('status')
  },
  query() {
    return container.queryByRole('status')
  },
  /** The call-to-action link, by its label. */
  cta(label: string) {
    return container.getByRole('link', { name: label })
  },
  queryText(text: string) {
    return container.queryByText(text)
  },
})

/**
 * Test page-object for `ChannelSetupNudge`. It renders a typed
 * `<Link to="/settings">`, so `render` mounts it under a minimal memory router
 * that registers that route; the router resolves on first paint, so tests start
 * with `await channelSetupNudgePage.find...()`.
 */
export const channelSetupNudgePage = {
  render(overrides: Partial<ChannelSetupNudgeProps> = {}) {
    const props = buildChannelSetupNudgeProps(overrides)
    const rootRoute = createRootRoute()
    const indexRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: '/',
      component: () => <ChannelSetupNudge {...props} />,
    })
    // The settings route the CTA deep-links to — registered so the typed
    // <Link to="/settings"> resolves at render time.
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

  /** Async-first accessor — the router resolves the tree on first paint. */
  findCta(label: string) {
    return screen.findByRole('link', { name: label })
  },

  within(container: Container = screen) {
    return scoped(container)
  },

  ...scoped(screen),
}
