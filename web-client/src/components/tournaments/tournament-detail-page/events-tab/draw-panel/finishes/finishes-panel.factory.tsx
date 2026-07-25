import { buildFinishesEvent } from '../../../../data/seed.factory'
import type { FinishesPanelProps } from './finishes-panel'

/** Props for `FinishesPanel`: a single-elimination event **with finishes** — a decided
 * four-entrant bracket with a champion and a tied-3rd pair (`buildFinishesEvent`). The event
 * owns the `results` and the `entrants` the panel joins them against, so a test tweaks the
 * whole event (e.g. `buildEvent()` for the no-results case, or
 * `results: buildFinishesResults({ complete: false })` for a live one). */
export function buildFinishesPanelProps(
  overrides: Partial<FinishesPanelProps> = {},
): FinishesPanelProps {
  return { event: buildFinishesEvent(), ...overrides }
}
