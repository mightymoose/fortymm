import userEvent from '@testing-library/user-event'
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
  queryTitle(title: string) {
    return container.queryByText(title)
  },
  rowByTitle(title: string) {
    return container.getByText(title).closest('button') as HTMLButtonElement
  },
})

export const notificationsViewPage = {
  render(overrides: Partial<NotificationsViewProps> = {}) {
    render(<NotificationsView {...buildNotificationsViewProps(overrides)} />)
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
  async clickRow(title: string) {
    await userEvent.click(this.rowByTitle(title))
  },

  ...scoped(screen),
}
