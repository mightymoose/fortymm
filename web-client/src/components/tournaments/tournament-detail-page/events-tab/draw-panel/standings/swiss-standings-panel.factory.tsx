import {
  buildSwissStandingsEvent,
  swissStandingsResultsOf,
} from '../../../../data/seed.factory'
import { eventSwissStandings } from '../../../../data/swiss-standings'
import type { TournamentEvent } from '../../../../data/types'
import type { SwissStandingsPanelProps } from './swiss-standings-panel'

/** What a test varies: the whole **event** whose standings the panel is handed (the natural
 * unit — the results and the entrants they join against travel together), or a prop
 * directly. */
export type SwissStandingsPanelScenario = Partial<SwissStandingsPanelProps> & {
  event?: TournamentEvent
}

/**
 * Props for `SwissStandingsPanel`: by default a **swiss** event with results — one complete
 * five-deep table over the whole field, and a champion (`buildSwissStandingsEvent`, whose
 * field is five entrants over three rounds).
 *
 * The panel takes a view, not an event, but a test still reasons in events — so this derives
 * the props from one **the same way `ResultsPanel` does at runtime**: `eventSwissStandings`
 * over the event's own `swiss_standings` block. A test that hands over a differently-built
 * event therefore exercises the real selection path, not a hand-written view-model that
 * could drift from it.
 */
export function buildSwissStandingsPanelProps({
  event = buildSwissStandingsEvent(),
  ...overrides
}: SwissStandingsPanelScenario = {}): SwissStandingsPanelProps {
  return {
    eventId: event.id,
    eventName: event.name,
    standings: eventSwissStandings(event, swissStandingsResultsOf(event)),
    ...overrides,
  }
}
