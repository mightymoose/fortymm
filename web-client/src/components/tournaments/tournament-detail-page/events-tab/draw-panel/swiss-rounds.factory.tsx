import { drawState, type DrawRound } from '../../../data/draw'
import {
  buildSwissDrawnEvent,
  buildSwissMidEvent,
} from '../../../data/seed.factory'
import type { SwissRoundsProps } from './swiss-rounds'

/**
 * The rounds of an event's draw as the panel hands them over — **`drawState`'s own output**,
 * never a hand-written `DrawRound[]`.
 *
 * Derived from a whole event on purpose: `unpooled` is what the real routing feeds this
 * component, so a fixture built any other way could drift from the shape the panel actually
 * produces (round grouping, position order, the TBD/withdrawn side join). It throws on an
 * undrawn event rather than yielding `[]`, so a mis-built test says so at the call site.
 */
function unpooledRoundsOf(event: Parameters<typeof drawState>[0]): DrawRound[] {
  const state = drawState(event)
  if (state.kind !== 'drawn') {
    throw new Error(
      `Fixture event '${event.id}' has no draw cut, so it has no rounds to render.`,
    )
  }
  return state.unpooled
}

/** A **freshly cut** swiss draw: round 1 paired from the draw order, rounds 2 and 3 written
 * with both sides null. The state a director reviews the moment they cut. */
export function buildCutSwissRounds(): DrawRound[] {
  return unpooledRoundsOf(buildSwissDrawnEvent())
}

/**
 * The same draw **one round in**: round 1 played, round 2 paired by the standings, round 3
 * still waiting.
 *
 * The discriminating fixture. On the cut-fresh rounds above, "is this round paired?" and
 * "is this round 1?" give the same answer for every round — so a component keyed off the
 * round *number* passes on that fixture alone. Here they disagree.
 */
export function buildMidSwissRounds(): DrawRound[] {
  return unpooledRoundsOf(buildSwissMidEvent())
}

/** Props for `SwissRounds` — the freshly-cut three-round draw by default, which is the
 * state that shows both a paired round and forthcoming ones at once. */
export function buildSwissRoundsProps(
  overrides: Partial<SwissRoundsProps> = {},
): SwissRoundsProps {
  return { rounds: buildCutSwissRounds(), ...overrides }
}
