import { eventFinishes } from '../../../data/finishes'
import { eventStandings } from '../../../data/standings'
import { eventStandingsThenFinishes } from '../../../data/two-stage'
import type { TournamentEvent } from '../../../data/types'
import { FinishesPanel } from './finishes/finishes-panel'
import { StandingsPanel } from './standings/standings-panel'
import { TwoStagePanel } from './two-stage/two-stage-panel'

export interface ResultsPanelProps {
  event: TournamentEvent
}

/**
 * An event's **results** on its card in the Events tab — the one render path that switches on
 * the results shape (ADR-0785, widened by ADR 20260727): a **standings** table for
 * round-robin, a **finishes** placement list for single-elimination, and **both** — pools
 * above bracket, one champion — for round-robin-then-knockout. The results are a
 * discriminated union tagged by `kind`, parsed at the boundary (`../../../data/results`), so
 * this switch is exhaustive: a future draw type's shape is a **type error here** until it is
 * given a render arm.
 *
 * It renders **nothing** for an event with no results (`results === null`: an uncut event, or
 * a draw type with no results strategy yet) — the designed data state, so this drops into the
 * panel unconditionally, exactly as the standings panel used to.
 *
 * **This is the only component that knows which block applies.** It selects each block's view
 * (`eventStandings` / `eventFinishes`) and hands it to a panel that just renders what it is
 * given: no panel re-checks `kind`, so none of them can meet a shape it does not recognise and
 * quietly render nothing. Each block stays a pure view, live off the tournament-detail
 * payload, with no machinery of its own.
 */
export const ResultsPanel = ({ event }: ResultsPanelProps) => {
  const results = event.results

  // No results to show — an uncut or not-yet-supported event. Render nothing; a designed data
  // state, not a spinner and not a gap.
  if (results === null) return null

  switch (results.kind) {
    case 'standings':
      return (
        <StandingsPanel
          eventId={event.id}
          standings={eventStandings(event, results)}
        />
      )
    case 'finishes':
      return (
        <FinishesPanel
          eventId={event.id}
          eventName={event.name}
          finishes={eventFinishes(event, results)}
        />
      )
    case 'standings_then_finishes':
      // Both stages, on one card (ADR 20260727): the pool standings above the bracket
      // finishes, under a single champion banner naming the BRACKET's winner. The two
      // panels above are reused as they stand — the composite only selects and arranges.
      return (
        <TwoStagePanel
          eventId={event.id}
          eventName={event.name}
          twoStage={eventStandingsThenFinishes(event, results)}
        />
      )
    default: {
      // A results shape without a render arm is a TYPE error here, not a blank section.
      const exhaustive: never = results
      return exhaustive
    }
  }
}
