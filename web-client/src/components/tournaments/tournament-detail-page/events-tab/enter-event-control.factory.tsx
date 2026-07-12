import { buildEvent, buildTournament } from '../../data/seed.factory'
import type { EnterEventControlProps } from './enter-event-control'

/** Props for `EnterEventControl` — the seeded Open Singles event on the seeded
 * tournament, which is `published`: registration is open (ADR-0017), and the
 * signed-in player is NOT among its entrants by default (they are
 * `player.1`…`player.52`). So the default scenario is "offer Enter"; override
 * `tournament: buildTournament({ status: 'draft' })` for a shut window. */
export function buildEnterEventControlProps(
  overrides: Partial<EnterEventControlProps> = {},
): EnterEventControlProps {
  return {
    tournament: buildTournament(),
    event: buildEvent(),
    ...overrides,
  }
}
