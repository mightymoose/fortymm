import { render, screen, type Container } from '@/test/utilities'

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
