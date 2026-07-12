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

/** The inbox-empty headline. A filter that matches nothing deliberately does
 * NOT say this — it names the filter instead — so this string identifies the
 * inbox-empty state specifically, not "some empty state". */
const INBOX_EMPTY_HEADLINE = 'All caught up.'

/** The filter-empty headline, which names the filter that matched nothing. */
const filterEmptyHeadline = (filterLabel: string) =>
  `Nothing under ${filterLabel}.`

const scoped = (container: Container) => ({
  /** The inbox-empty headline under a router — async, since the router resolves
   * its initial match after first paint, so nothing is in the DOM yet. */
  findHeadline() {
    return container.findByText(INBOX_EMPTY_HEADLINE)
  },
  /** The inbox-empty headline in a plain (router-free) render. */
  queryHeadline() {
    return container.queryByText(INBOX_EMPTY_HEADLINE)
  },
  queryGoPlayCopy() {
    return container.queryByText('Nothing here. Go play.')
  },
  queryFilterCopy(filterLabel: string) {
    return container.queryByText(filterEmptyHeadline(filterLabel))
  },
  /** The filter-empty headline under a router — the async twin of
   * `queryFilterCopy`, for harnesses that mount one. */
  findFilterCopy(filterLabel: string) {
    return container.findByText(filterEmptyHeadline(filterLabel))
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
