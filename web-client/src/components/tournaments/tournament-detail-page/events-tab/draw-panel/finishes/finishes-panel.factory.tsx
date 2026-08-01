import { eventFinishes } from '../../../../data/finishes'
import {
  buildFinishesEvent,
  finishesResultsOf,
} from '../../../../data/seed.factory'
import type { TournamentEvent } from '../../../../data/types'
import type { FinishesPanelProps } from './finishes-panel'

/** What a test varies: the whole **event** whose finishes the panel is handed (the natural
 * unit — the results and the entrants they join against travel together), or a prop
 * directly. */
export type FinishesPanelScenario = Partial<FinishesPanelProps> & {
  event?: TournamentEvent
}

/**
 * Props for `FinishesPanel`: by default a single-elimination event **with finishes** — a
 * decided four-entrant bracket with a champion and a tied-3rd pair (`buildFinishesEvent`).
 *
 * The panel no longer takes an event, but a test still reasons in events, so this derives
 * the props from one **the same way `ResultsPanel` does at runtime** — `eventFinishes` over
 * the event's own `finishes` block. A test that hands over a differently-built event
 * therefore exercises the real selection path, not a hand-written view-model that could
 * drift from it.
 */
export function buildFinishesPanelProps({
  event = buildFinishesEvent(),
  ...overrides
}: FinishesPanelScenario = {}): FinishesPanelProps {
  return {
    eventId: event.id,
    eventName: event.name,
    finishes: eventFinishes(event, finishesResultsOf(event)),
    ...overrides,
  }
}
