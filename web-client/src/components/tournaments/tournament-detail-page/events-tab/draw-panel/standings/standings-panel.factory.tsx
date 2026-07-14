import { buildStandingsEvent } from '../../../../data/seed.factory'
import type { StandingsPanelProps } from './standings-panel'

/** Props for `StandingsPanel`: a round-robin event **with results** — a complete single
 * pool and a champion (`buildStandingsEvent`). The event owns the `results` and the
 * `entrants` the panel joins them against, so a test tweaks the whole event (e.g.
 * `buildEvent()` for the no-results case, `results: buildEventResults({ complete: false })`
 * for a live one). */
export function buildStandingsPanelProps(
  overrides: Partial<StandingsPanelProps> = {},
): StandingsPanelProps {
  return { event: buildStandingsEvent(), ...overrides }
}
