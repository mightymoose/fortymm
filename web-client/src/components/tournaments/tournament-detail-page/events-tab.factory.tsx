import { buildTournament } from '../data/seed.factory'
import type { EventsTabProps } from './events-tab'

/** Props for `EventsTab` — the seeded one-event tournament. Its draw-type catalogue
 * rides on the tournament (`buildTournament` seeds one), not as a prop of its own: the
 * tab reads it off the payload, so there is no second knob here to set it out of step
 * with. */
export function buildEventsTabProps(
  overrides: Partial<EventsTabProps> = {},
): EventsTabProps {
  return {
    tournament: buildTournament(),
    canEdit: true,
    onOpenEvent: () => {},
    onNewEvent: () => {},
    ...overrides,
  }
}
