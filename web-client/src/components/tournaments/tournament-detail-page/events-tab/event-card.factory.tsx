import { buildDrawTypes, buildEvent } from '../../data/seed.factory'
import type { EventCardProps } from './event-card'

/** Props for `EventCard` — the seeded Open Singles event, hosting no control of
 * its own (pass `action` to give the card one), with the draw-type catalogue the
 * server serves (ADR 20260726) — the card labels the event's draw type through it. */
export function buildEventCardProps(
  overrides: Partial<EventCardProps> = {},
): EventCardProps {
  return {
    event: buildEvent(),
    canEdit: true,
    drawTypes: buildDrawTypes(),
    onOpen: () => {},
    ...overrides,
  }
}
