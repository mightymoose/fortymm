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
    pools: [
      buildPool({ id: 'p-1', name: 'Pool A' }),
      buildPool({ id: 'p-2', name: 'Pool B' }),
      buildPool({ id: 'p-3', name: 'Pool C' }),
    ],
    ...overrides,
  })
}

/** The **drawn** U1200 Singles as it stands once play has started: its first fixture has
 * a **recorded winner**. That is precisely what the panel's 409 play guard is about ("at
 * least one fixture has a match or a recorded winner") — and it arrives on the click's
 * own settle refetch, which is why it must not be the thing that withdraws the refusal
 * (`drawConfigFingerprint`). Its configuration — format, draw type, two pools, five
 * entrants — is untouched.
 *
 * The winner arm rather than the match arm on purpose: a *materialized* fixture renders a
 * typed `<Link>` to its match, which needs a `RouterProvider` (`@/test/router`) whose
 * router owns the tree — and the whole point of this fixture is to be handed to a
 * `rerender`. Both arms are the same evidence to the same server guard. */
export function buildUnderWayEvent(): TournamentEvent {
  const drawn = buildDrawnEvent()
  return {
    ...drawn,
    fixtures: drawn.fixtures.map((fixture, i) =>
      i === 0 ? { ...fixture, winnerEntryId: fixture.entryAId } : fixture,
    ),
  }
}
