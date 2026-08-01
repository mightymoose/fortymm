import {
  buildTwoStageEvent,
  twoStageResultsOf,
} from '../../../../data/seed.factory'
import { eventStandingsThenFinishes } from '../../../../data/two-stage'
import type { TournamentEvent } from '../../../../data/types'
import type { TwoStagePanelProps } from './two-stage-panel'

/** What a test varies: the whole **event** whose two-stage results the panel is handed (the
 * natural unit — the results and the entrants they join against travel together), or a prop
 * directly. */
export type TwoStagePanelScenario = Partial<TwoStagePanelProps> & {
  event?: TournamentEvent
}

/**
 * Props for `TwoStagePanel`: by default a played-out `rr-then-ko` event — two decided pools,
 * a bracket run to a final, and a champion who tops **no** pool (`buildTwoStageEvent`).
 *
 * The props are derived from the event **the same way `ResultsPanel` does at runtime** —
 * `eventStandingsThenFinishes` over the event's own two-stage block — so a test that hands
 * over a differently-built event (the mid-flight one, say) exercises the real selection
 * path, not a hand-written view-model that could drift from it.
 */
export function buildTwoStagePanelProps({
  event = buildTwoStageEvent(),
  ...overrides
}: TwoStagePanelScenario = {}): TwoStagePanelProps {
  return {
    eventId: event.id,
    eventName: event.name,
    twoStage: eventStandingsThenFinishes(event, twoStageResultsOf(event)),
    ...overrides,
  }
}
