import { drawState, type DrawRound } from '../../../data/draw'
import {
  buildSwissDrawnEvent,
  buildSwissMidEvent,
} from '../../../data/seed.factory'
import type { TournamentEvent } from '../../../data/types'
import type { SwissRoundsProps } from './swiss-rounds'

/**
 * A whole event's draw as the panel hands it over — **`drawState`'s own output**, never a
 * hand-written `DrawRound[]` or a hand-written bye map.
 *
 * Derived from a whole event on purpose: this is what the real routing feeds this
 * component, so props built any other way could drift from the shape the panel actually
 * produces (round grouping, position order, the TBD/withdrawn side join — and now the bye
 * subtraction, which is the derivation under test and must not be restated here). It
 * throws on an undrawn event rather than yielding `[]`, so a mis-built test says so at the
 * call site.
 */
export function buildSwissRoundsPropsFor(
  event: TournamentEvent,
): SwissRoundsProps {
  const state = drawState(event)
  if (state.kind !== 'drawn') {
    throw new Error(
      `Fixture event '${event.id}' has no draw cut, so it has no rounds to render.`,
    )
  }
  return { rounds: state.ungrouped, byes: state.swissByes }
}

/** Just the rounds of an event's draw — the same output, for the assertions that only
 * read the fixtures. */
function ungroupedRoundsOf(event: TournamentEvent): DrawRound[] {
  return buildSwissRoundsPropsFor(event).rounds
}

/** A **freshly cut** swiss draw: round 1 paired from the draw order, rounds 2 and 3 written
 * with both sides null. The state a director reviews the moment they cut. */
export function buildCutSwissRounds(): DrawRound[] {
  return ungroupedRoundsOf(buildSwissDrawnEvent())
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
  return ungroupedRoundsOf(buildSwissMidEvent())
}

/** Props for `SwissRounds` — the freshly-cut three-round draw by default, which is the
 * state that shows both a paired round and forthcoming ones at once. Its field is **even**
 * (six), so nobody sits out: a bye case passes the odd fixtures through
 * `buildSwissRoundsPropsFor`. */
export function buildSwissRoundsProps(
  overrides: Partial<SwissRoundsProps> = {},
): SwissRoundsProps {
  return { ...buildSwissRoundsPropsFor(buildSwissDrawnEvent()), ...overrides }
}
