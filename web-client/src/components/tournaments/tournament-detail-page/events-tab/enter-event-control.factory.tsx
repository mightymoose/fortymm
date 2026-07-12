import { buildEvent } from '../../data/seed.factory'
import type { EnterEventControlProps } from './enter-event-control'

/** Props for `EnterEventControl` — the seeded Open Singles event on the seeded
 * tournament. The signed-in player is NOT among its entrants by default (they
 * are `player.1`…`player.52`), so the default scenario is "offer Enter". */
export function buildEnterEventControlProps(
  overrides: Partial<EnterEventControlProps> = {},
): EnterEventControlProps {
  return {
    tournamentId: 'bay-area-open-2026',
    event: buildEvent(),
    ...overrides,
  }
}
