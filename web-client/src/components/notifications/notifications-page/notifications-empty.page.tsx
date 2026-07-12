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

/** The headline both empty states share. Declared once: every harness that
 * needs it — router-mounted or not, this component's or the view's — reads it
 * from here rather than re-typing the copy. */
const HEADLINE = 'All caught up.'

const scoped = (container: Container) => ({
  /** The headline under a router — async, since the router resolves its initial
   * match after first paint, so nothing is in the DOM yet. */
  findHeadline() {
    return container.findByText(HEADLINE)
  },
  /** The headline in a plain (router-free) render — see the view's page object,
   * whose link-free states mount without one. */
  queryHeadline() {
    return container.queryByText(HEADLINE)
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
