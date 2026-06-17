import userEvent from '@testing-library/user-event'
import { render, screen, type Container } from '@/test/utilities'
import { NotificationRow, type NotificationRowProps } from './notification-row'
import { buildNotificationRowProps } from './notification-row.factory'

const scoped = (container: Container) => ({
  /** The whole row — a single button. */
  getRow() {
    return container.getByRole('button')
  },
  /** The sr-only "Unread." marker — present only on unread rows. */
  queryUnreadMarker() {
    return container.queryByText('Unread.')
  },
  /** Text anywhere in the row (title, body, delta chip, CTA, time). */
  queryText(text: string) {
    return container.queryByText(text)
  },
  getText(text: string) {
    return container.getByText(text)
  },
})

/** Page object for `NotificationRow`. Tests the single shared feed row in
 * isolation; embed `within(row)` from a list page object to reuse these. */
export const notificationRowPage = {
  render(overrides: Partial<NotificationRowProps> = {}) {
    render(<NotificationRow {...buildNotificationRowProps(overrides)} />)
  },

  within(container: Container = screen) {
    return scoped(container)
  },

  async clickRow() {
    await userEvent.click(this.getRow())
  },

  ...scoped(screen),
}
