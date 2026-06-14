import { buildEvent } from '../../data/seed.factory'
import type { EventCardProps } from './event-card'

/** Props for `EventCard` — the seeded Open Singles event. */
export function buildEventCardProps(
  overrides: Partial<EventCardProps> = {},
): EventCardProps {
  return { event: buildEvent(), onOpen: () => {}, ...overrides }
}
