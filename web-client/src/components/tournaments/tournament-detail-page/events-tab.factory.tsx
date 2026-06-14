import { buildTournament } from '../data/seed.factory'
import type { EventsTabProps } from './events-tab'

/** Props for `EventsTab` — the seeded one-event tournament. */
export function buildEventsTabProps(
  overrides: Partial<EventsTabProps> = {},
): EventsTabProps {
  return {
    tournament: buildTournament(),
    onOpenEvent: () => {},
    onNewEvent: () => {},
    ...overrides,
  }
}
