import userEvent from '@testing-library/user-event'
import { renderWithRoutes } from '@/test/router'
import { render, screen, type Container } from '@/test/utilities'
import { NotificationsView, type NotificationsViewProps } from './notifications-view'
import { buildNotificationsViewProps } from './notifications-view.factory'

const scoped = (container: Container) => ({
  getHeading() {
    return container.getByRole('heading', { name: 'NOTIFICATIONS' })
  },
  /** A filter pill by its visible label (All / Unread / category short). */
  getFilter(label: string) {
    return container.getByRole('button', { name: label })
  },
  getMarkAllRead() {
    return container.getByRole('button', { name: 'Mark all read' })
  },
  queryUnreadBadge() {
    return container.queryByText(/\d+ unread/)
  },
  queryEmptyState() {
    return container.queryByText('All caught up.')
  },
  /** The empty state under a router — async, since the router resolves its
   * initial match after first paint. See `renderEmptyInbox`. */
  findEmptyState() {
    return container.findByText('All caught up.')
  },
  queryLogMatchLink() {
    return container.queryByRole('link', { name: 'Log a match' })
  },
  queryShowAll() {
    return container.queryByRole('button', { name: 'Show all notifications' })
  },
  queryTitle(title: string) {
    return container.queryByText(title)
  },
  rowByTitle(title: string) {
    return container.getByText(title).closest('button') as HTMLButtonElement
  },
})

export const notificationsViewPage = {
  render(overrides: Partial<NotificationsViewProps> = {}) {
    const utils = render(<NotificationsView {...buildNotificationsViewProps(overrides)} />)
    return {
      ...utils,
      /** Re-render with a fresh set of overrides (e.g. an updated feed). */
      rerenderWith(next: Partial<NotificationsViewProps> = {}) {
        utils.rerender(<NotificationsView {...buildNotificationsViewProps(next)} />)
      },
    }
  },

  /**
   * `render`, but mounted under a memory router.
   *
   * Only the *inbox-empty* state (no notifications at all) renders typed
   * `<Link>`s, and a `<Link>` needs a router registering its target — so this is
   * the harness for a feed with no items. Every other state, the filter-empty
   * one included, is link-free and uses the plain `render` above. The router
   * resolves asynchronously: start with `await findEmptyState()`.
   */
  renderEmptyInbox(overrides: Partial<NotificationsViewProps> = {}) {
    return renderWithRoutes(
      <NotificationsView
        {...buildNotificationsViewProps({ items: [], unreadCount: 0, ...overrides })}
      />,
      { linkTargets: ['/matches/new', '/notifications/settings'] },
    )
  },

  within(container: Container = screen) {
    return scoped(container)
  },

  async clickFilter(label: string) {
    await userEvent.click(this.getFilter(label))
  },
  async clickMarkAllRead() {
    await userEvent.click(this.getMarkAllRead())
  },
  async clickShowAll() {
    await userEvent.click(
      screen.getByRole('button', { name: 'Show all notifications' }),
    )
  },
  async clickRow(title: string) {
    await userEvent.click(this.rowByTitle(title))
  },

  ...scoped(screen),
}
