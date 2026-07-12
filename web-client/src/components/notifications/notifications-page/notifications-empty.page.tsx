import userEvent from '@testing-library/user-event'
import { renderWithRoutes } from '@/test/router'
import { screen, type Container } from '@/test/utilities'
import {
  NotificationsEmpty,
  type NotificationsEmptyProps,
} from './notifications-empty'
import { buildNotificationsEmptyProps } from './notifications-empty.factory'

/** The routes the inbox-empty CTAs link to. Exported so any harness mounting
 * this component registers the same set — a `<Link>` whose target the router
 * doesn't know throws at render. */
export const EMPTY_STATE_LINK_TARGETS = [
  '/matches/new',
  '/notifications/settings',
]

const scoped = (container: Container) => ({
  /** The headline, shared by both empty states. Async: the router resolves its
   * initial match asynchronously, so nothing is in the DOM on first paint. */
  findHeadline() {
    return container.findByText('All caught up.')
  },
  queryGoPlayCopy() {
    return container.queryByText('Nothing here. Go play.')
  },
  queryFilterCopy(filterLabel: string) {
    return container.queryByText(`Nothing under ${filterLabel}.`)
  },
  queryLogMatchLink() {
    return container.queryByRole('link', { name: 'Log a match' })
  },
  queryPreferencesLink() {
    return container.queryByRole('link', { name: 'Notification preferences' })
  },
  queryShowAll() {
    return container.queryByRole('button', { name: 'Show all notifications' })
  },
  getShowAll() {
    return container.getByRole('button', { name: 'Show all notifications' })
  },
})

/**
 * Test page-object for `NotificationsEmpty`. The inbox-empty state renders
 * typed `<Link>`s, so it mounts under a minimal router registering their
 * targets. Tests must start with `await notificationsEmptyPage.findHeadline()`.
 */
export const notificationsEmptyPage = {
  render(overrides: Partial<NotificationsEmptyProps> = {}) {
    return renderWithRoutes(
      <NotificationsEmpty {...buildNotificationsEmptyProps(overrides)} />,
      { linkTargets: EMPTY_STATE_LINK_TARGETS },
    )
  },

  within(container: Container = screen) {
    return scoped(container)
  },

  async clickShowAll() {
    await userEvent.click(this.getShowAll())
  },

  ...scoped(screen),
}
