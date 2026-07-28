import {
  buildStandingsEvent,
  standingsResultsOf,
} from '../../../../data/seed.factory'
import { eventStandings } from '../../../../data/standings'
import type { TournamentEvent } from '../../../../data/types'
import type { StandingsPanelProps } from './standings-panel'

/** What a test varies: the whole **event** whose standings the panel is handed (the natural
 * unit — the results and the entrants they join against travel together), or a prop
 * directly. */
export type StandingsPanelScenario = Partial<StandingsPanelProps> & {
  event?: TournamentEvent
}

/**
 * Props for `StandingsPanel`: by default a round-robin event **with results** — a complete
 * single pool and a champion (`buildStandingsEvent`).
 *
 * The panel no longer takes an event, but a test still reasons in events, so this derives
 * the props from one **the same way `ResultsPanel` does at runtime** — `eventStandings`
 * over the event's own `standings` block. A test that hands over a differently-built event
 * therefore exercises the real selection path, not a hand-written view-model that could
 * drift from it.
 */
export function buildStandingsPanelProps({
  event = buildStandingsEvent(),
  ...overrides
}: StandingsPanelScenario = {}): StandingsPanelProps {
  return {
    eventId: event.id,
    standings: eventStandings(event, standingsResultsOf(event)),
    ...overrides,
  }
}
