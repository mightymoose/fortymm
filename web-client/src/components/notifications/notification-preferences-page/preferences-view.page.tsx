import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router'
import userEvent from '@testing-library/user-event'
import { render, screen, type Container } from '@/test/utilities'
import { PreferencesView, type PreferencesViewProps } from './preferences-view'
import { buildPreferencesViewProps } from './preferences-view.factory'

const scoped = (container: Container) => ({
  getHeading() {
    return container.getByRole('heading', { name: 'NOTIFICATIONS' })
  },
  /** A channel "sign-up" master switch, by channel label (In-app/Push/...). */
  channelSwitch(label: string) {
    return container.getByRole('switch', { name: `${label} notifications` })
  },
  /** A matrix cell checkbox, by category + channel label. */
  cell(categoryLabel: string, channelLabel: string) {
    return container.getByRole('checkbox', {
      name: `${categoryLabel} via ${channelLabel}`,
    })
  },
  /** A channel setup-nudge CTA link, by its label (e.g. "Add email"). */
  nudgeCta(label: string) {
    return container.getByRole('link', { name: label })
  },
  queryNudgeCta(label: string) {
    return container.queryByRole('link', { name: label })
  },
  queryText(text: string) {
    return container.queryByText(text)
  },
})

export const preferencesViewPage = {
  render(overrides: Partial<PreferencesViewProps> = {}) {
    const props = buildPreferencesViewProps(overrides)
    const rootRoute = createRootRoute()
    const indexRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: '/',
      component: () => <PreferencesView {...props} />,
    })
    // The settings route the setup nudges deep-link to — registered so the
    // typed <Link to="/settings"> resolves at render time.
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

  /** Async-first accessor — the router resolves the tree on first paint, so
   * tests await this before reading the synchronous accessors. */
  findHeading() {
    return screen.findByRole('heading', { name: 'NOTIFICATIONS' })
  },

  within(container: Container = screen) {
    return scoped(container)
  },

  async toggleChannel(label: string) {
    await userEvent.click(this.channelSwitch(label))
  },
  async toggleCell(categoryLabel: string, channelLabel: string) {
    await userEvent.click(this.cell(categoryLabel, channelLabel))
  },

  ...scoped(screen),
}
