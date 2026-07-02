import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router'

import { render, screen, type Container } from '@/test/utilities'

import { RatedField, type RatedFieldProps } from './rated-field'
import { buildRatedFieldProps } from './rated-field.factory'

const scoped = (container: Container) => ({
  /** The rated-match switch. Async: the router resolves its initial match
   * asynchronously, so `RatedField` is not in the DOM on first paint. */
  findSwitch() {
    return container.findByRole('switch', { name: 'Rated match' })
  },
  /** The description line under the switch. */
  findDescription(text: string | RegExp) {
    return container.findByText(text)
  },
  /** The "No opponent · unavailable" badge next to the field label. */
  queryUnavailableBadge() {
    return container.queryByText('No opponent · unavailable')
  },
  /** The guest "add an email" link, shown only while rated + guest. */
  queryGuestLink() {
    return container.queryByRole('link', { name: /add an email/i })
  },
})

/**
 * Test page-object for `RatedField`. Renders a typed `<Link>` to `/settings`
 * when the guest hint is visible, so `render` mounts under a minimal router
 * that registers that route. The router resolves its initial match
 * asynchronously, so tests must start with `await ratedFieldPage.find...()`.
 */
export const ratedFieldPage = {
  render(overrides: Partial<RatedFieldProps> = {}) {
    const props = buildRatedFieldProps(overrides)
    const rootRoute = createRootRoute()
    const indexRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: '/',
      component: () => <RatedField {...props} />,
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

  within(container: Container = screen) {
    return scoped(container)
  },

  ...scoped(screen),
}
