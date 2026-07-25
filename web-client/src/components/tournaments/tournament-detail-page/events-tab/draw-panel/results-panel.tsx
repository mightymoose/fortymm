import type { TournamentEvent } from '../../../data/types'
import { FinishesPanel } from './finishes/finishes-panel'
import { StandingsPanel } from './standings/standings-panel'

export interface ResultsPanelProps {
  event: TournamentEvent
}

/**
 * An event's **results** on its card in the Events tab — the one render path that switches on
 * the results shape (ADR-0785): a **standings** table for round-robin, a **finishes**
 * placement list for single-elimination. The results are a discriminated union tagged by
 * `kind`, parsed at the boundary (`../../../data/results`), so this switch is exhaustive: a
 * future draw type's shape is a **type error here** until it is given a render arm.
 *
 * It renders **nothing** for an event with no results (`results === null`: an uncut event, or
 * a draw type with no results strategy yet) — the designed data state, so this drops into the
 * panel unconditionally, exactly as the standings panel used to. Each arm is itself a pure
 * view over the event, live off the tournament-detail payload with no machinery of its own.
 */
export const ResultsPanel = ({ event }: ResultsPanelProps) => {
  const results = event.results

  // No results to show — an uncut or not-yet-supported event. Render nothing; a designed data
  // state, not a spinner and not a gap.
  if (results === null) return null

  switch (results.kind) {
    case 'standings':
      return <StandingsPanel event={event} />
    case 'finishes':
      return <FinishesPanel event={event} />
    default: {
      // A results shape without a render arm is a TYPE error here, not a blank section.
      const exhaustive: never = results
      return exhaustive
    }
  }
}
