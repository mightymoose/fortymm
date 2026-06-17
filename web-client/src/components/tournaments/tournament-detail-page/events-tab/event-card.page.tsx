import { render, screen, type Container } from '@/test/utilities'

import { EventCard, type EventCardProps } from './event-card'
import { buildEventCardProps } from './event-card.factory'

const scoped = (container: Container) => ({
  /** The full-card open target — labelled `Edit <event>` for an owner, or
   * `View <event>` for a non-owner (read-only). Pass the verb to assert the
   * read-only case. */
  getOpenButton(name: string, verb: 'Edit' | 'View' = 'Edit') {
    return container.getByRole('button', { name: `${verb} ${name}` })
  },
})

/** Test page-object for `EventCard`. */
export const eventCardPage = {
  render(overrides: Partial<EventCardProps> = {}) {
    render(<EventCard {...buildEventCardProps(overrides)} />)
  },

  within(container: Container = screen) {
    return scoped(container)
  },

  ...scoped(screen),
}
