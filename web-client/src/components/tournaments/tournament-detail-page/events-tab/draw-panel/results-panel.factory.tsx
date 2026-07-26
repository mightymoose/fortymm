import { buildStandingsEvent } from '../../../data/seed.factory'
import type { ResultsPanelProps } from './results-panel'

/** Props for `ResultsPanel`: by default a round-robin event **with standings**
 * (`buildStandingsEvent`) — the regression case. A test switches shapes by passing a whole
 * event: `buildFinishesEvent()` for the single-elimination placement list, `buildEvent()` for
 * the no-results case. */
export function buildResultsPanelProps(
  overrides: Partial<ResultsPanelProps> = {},
): ResultsPanelProps {
  return { event: buildStandingsEvent(), ...overrides }
}
