import userEvent from '@testing-library/user-event'

import { render, screen, within, type Container } from '@/test/utilities'

import { EventsTab, type EventsTabProps } from './events-tab'
import { buildEventsTabProps } from './events-tab.factory'
import { eventCardPage } from './events-tab/event-card.page'

const scoped = (container: Container) => ({
  getNewEventButton() {
    // The header action and the empty-state CTA both create events; take the
    // first so the accessor resolves whether or not the list is empty.
    return container.getAllByRole('button', { name: /New event|Add an event/ })[0]
  },
  /** The "New event" / "Add an event" create affordances — absent for a
   * non-creator (`canEdit: false`). */
  queryNewEventButtons() {
    return container.queryAllByRole('button', { name: /New event|Add an event/ })
  },
  /** The checkout panel (#1809), which replaces the event list while a
   * checkout is open. */
  findCheckoutPanel() {
    return container.findByRole('region', { name: 'Checkout' })
  },
  queryCheckoutPanel() {
    return container.queryByRole('region', { name: 'Checkout' })
  },
  /** Press "Cancel checkout" and confirm it. */
  async cancelCheckout() {
    await userEvent.click(container.getByRole('button', { name: 'Cancel checkout' }))
    const dialog = await screen.findByRole('alertdialog')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel checkout' }))
  },
  /** Press "Change selection" and confirm the release. */
  async changeSelection() {
    await userEvent.click(container.getByRole('button', { name: 'Change selection' }))
    const dialog = await screen.findByRole('alertdialog')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Release and change' }))
  },
  ...eventCardPage.within(container),
})

/** Test page-object for `EventsTab`. */
export const eventsTabPage = {
  render(overrides: Partial<EventsTabProps> = {}) {
    render(<EventsTab {...buildEventsTabProps(overrides)} />)
  },

  within(container: Container = screen) {
    return scoped(container)
  },

  ...scoped(screen),
}
