import {
  buildDrawnEvent,
  buildEntrants,
  buildEvent,
  buildPool,
} from '../../data/seed.factory'
import type { TournamentEvent } from '../../data/types'
import type { DrawPanelProps } from './draw-panel'

/** Props for `DrawPanel` — the **drawn** U1200 Singles (round-robin, two pools, an odd
 * Pool A), read by its director.
 *
 * Drawn by default because that is the state with something in it: the undrawn case is
 * one line of copy, and a bare `render()` that showed it would make the panel's whole
 * job invisible. Pass `event: buildEvent()` for the empty state, `canEdit: false` for a
 * player's view. */
export function buildDrawPanelProps(
  overrides: Partial<DrawPanelProps> = {},
): DrawPanelProps {
  return {
    tournamentId: 'bay-area-open-2026',
    event: buildDrawnEvent(),
    canEdit: true,
    ...overrides,
  }
}

/** A **single-elimination** event with a field of one and no pools — the configuration
 * the bracket 422 is produced about ("a bracket of one has nobody to play"), and the one
 * a director leaves by changing the draw type (#1123) or by finding a second player. */
export function buildLoneBracketEvent(
  overrides: Partial<Omit<TournamentEvent, 'entered'>> = {},
): TournamentEvent {
  return buildEvent({
    id: 'ev-bracket',
    name: 'Championship Singles',
    drawType: 'single-elim',
    entrants: buildEntrants(1),
    // Un-pooled — a bracket has no pools (ADR-0786).
    pools: [],
    ...overrides,
  })
}

/** A round-robin event with two pools and **nobody in it yet** — the configuration the
 * snake refuses with "0 entrants across 2 pool(s) would leave a pool with fewer than 2
 * entrants…", and the one the first entrant ends (#1049 Repro B). */
export function buildEmptyFieldEvent(
  overrides: Partial<Omit<TournamentEvent, 'entered'>> = {},
): TournamentEvent {
  return buildEvent({
    id: 'ev-rr',
    name: 'U1500 Singles',
    drawType: 'round-robin',
    entrants: [],
    pools: [
      buildPool({ id: 'p-1', name: 'Pool A' }),
      buildPool({ id: 'p-2', name: 'Pool B' }),
    ],
    ...overrides,
  })
}

/** A round-robin event with **five entrants across three pools** — the snake would leave
 * a pool with one player, so the cut is refused with the numbers in it. The refusal the
 * inverse case is built on: it turns on those two counts and nothing else, so a rename, a
 * table assignment or a raised cap leaves it true. */
export function buildCrowdedPoolsEvent(
  overrides: Partial<Omit<TournamentEvent, 'entered'>> = {},
): TournamentEvent {
  return buildEvent({
    id: 'ev-rr',
    name: 'U1500 Singles',
    drawType: 'round-robin',
    entrants: buildEntrants(5),
    // Positions stamped explicitly, carried over from the inline fixture this factory
    // replaced (#1238): `buildPool` defaults every pool to `position: 0`, and the draw
    // now ORDERS by position — three pools sharing one would render in an order nothing
    // pins. A, B, C is the order this refusal's sentence counts.
    pools: [
      buildPool({ id: 'p-1', name: 'Pool A', position: 0 }),
      buildPool({ id: 'p-2', name: 'Pool B', position: 1 }),
      buildPool({ id: 'p-3', name: 'Pool C', position: 2 }),
    ],
    ...overrides,
  })
}

/** The same U1200 Singles after somebody **re-cut its draw** — every fixture is a
 * different row than the one it replaced (new ids, the two sides swapped), and not one of
 * them has been played.
 *
 * The fixture change that carries **no evidence of play**, which is what makes it useful:
 * `buildUnderWayEvent` moves the fixtures and freezes the verbs at the same time, so it
 * cannot tell a refusal withdrawn by the fingerprint from one superseded by the freeze.
 * This one moves the fixtures and leaves the verbs live, so only the fingerprint can
 * decide. Its configuration — format, draw type, two pools, five entrants — is untouched. */
export function buildRecutFixturesEvent(): TournamentEvent {
  const drawn = buildDrawnEvent()
  return {
    ...drawn,
    fixtures: drawn.fixtures.map((fixture) => ({
      ...fixture,
      id: `${fixture.id}-recut`,
      entryAId: fixture.entryBId,
      entryBId: fixture.entryAId,
    })),
  }
}
