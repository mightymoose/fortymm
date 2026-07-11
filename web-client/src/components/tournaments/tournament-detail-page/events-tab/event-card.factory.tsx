import { buildEvent } from '../../data/seed.factory'
import type { EventCardProps } from './event-card'

/** Props for `EventCard` — the seeded Open Singles event, hosting no control of
 * its own (pass `action` to give the card one). */
export function buildEventCardProps(
  overrides: Partial<EventCardProps> = {},
): EventCardProps {
  return { event: buildEvent(), canEdit: true, onOpen: () => {}, ...overrides }
}
