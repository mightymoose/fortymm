import { render, screen, type Container } from '@/test/utilities'

import { EventCard, type EventCardProps } from './event-card'
import { buildEventCardProps } from './event-card.factory'

const scoped = (container: Container) => ({
  /** The full-card open target, named `Edit <event>`. */
  getOpenButton(name: string) {
    return container.getByRole('button', { name: `Edit ${name}` })
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
