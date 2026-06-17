import userEvent from '@testing-library/user-event'
import { render, screen, type Container } from '@/test/utilities'
import {
  NotificationDropdown,
  type NotificationDropdownProps,
} from './notification-dropdown'
import { buildNotificationDropdownProps } from './notification-dropdown.factory'

const scoped = (container: Container) => ({
  getHeading() {
    return container.getByRole('heading', { name: 'Notifications' })
  },
  /** The "N new" pill — absent when nothing is unread. */
  queryNewBadge() {
    return container.queryByText(/\d+ new/)
  },
  queryMarkAllRead() {
    return container.queryByRole('button', { name: 'Mark all read' })
  },
  getSeeAll() {
    return container.getByRole('button', { name: /see all notifications/i })
  },
  /** The empty-state copy — present only when there are no items. */
  queryEmptyState() {
    return container.queryByText('All caught up.')
  },
  queryLoading() {
    return container.queryByText('Loading…')
  },
  queryError() {
    return container.queryByText("Couldn't load notifications. Try again.")
  },
  /** A row's clickable button, located by its title text. */
  rowByTitle(title: string) {
    return container.getByText(title).closest('button') as HTMLButtonElement
  },
  queryTitle(title: string) {
    return container.queryByText(title)
  },
})

export const notificationDropdownPage = {
  render(overrides: Partial<NotificationDropdownProps> = {}) {
    render(<NotificationDropdown {...buildNotificationDropdownProps(overrides)} />)
  },

  within(container: Container = screen) {
    return scoped(container)
  },

  async clickRow(title: string) {
    await userEvent.click(this.rowByTitle(title))
  },
  async clickMarkAllRead() {
    const button = this.queryMarkAllRead()
    if (button) await userEvent.click(button)
  },
  async clickSeeAll() {
    await userEvent.click(this.getSeeAll())
  },

  ...scoped(screen),
}
