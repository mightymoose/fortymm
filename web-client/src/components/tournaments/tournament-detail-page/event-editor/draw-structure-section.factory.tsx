import { buildPool, buildRrThenKoEvent } from '../../data/seed.factory'
import { poolLetter } from '../../data/draw-structure'
import { keepPools } from '../../data/pool-entries'
import type { TournamentEvent } from '../../data/types'
import type { DrawStructureSectionProps } from './draw-structure-section'

/**
 * The reference's **"Nothing set"** state
 * (`docs/designs/rr-then-ko-draw-structure/nothing-set.png`): a two-stage event capped
 * at **32 players** with **four** pool reservations, so the tab derives 4 pools of 8 and
 * 2 qualifiers apiece, and every setting is the system's.
 *
 * ⚠️ **Both numbers are stated here rather than inherited**, because two of the four
 * source sentences read them out — `32 players ÷ 4 pools` and
 * `4 pool reservations · today's behaviour`. A cap or a pool count that moved under this
 * factory would move the copy the tests pin, and the red would look like a copy bug.
 *
 * The split is deliberately **even** (32 ÷ 4 = 8), so the uneven case is something a
 * test asks for rather than something it gets by accident.
 */
export function buildDrawStructureEvent(
  overrides: Partial<Omit<TournamentEvent, 'entered'>> = {},
): TournamentEvent {
  return buildRrThenKoEvent({
    maxPlayers: 32,
    pools: Array.from({ length: 4 }, (_, i) =>
      buildPool({
        id: `p-${poolLetter(i).toLowerCase()}`,
        name: `Pool ${poolLetter(i)}`,
        position: i,
      }),
    ),
    ...overrides,
  })
}

/** Props for `DrawStructureSection` — the "Nothing set" event above, editable by the
 * director looking at it, and spy-able ways to write a setting back and to get to Basics.
 *
 * `canEdit: true` is the default because it is the state the tab is *for*; the guard test
 * asks for the other one explicitly, which is what makes "a reader sees no control" a
 * claim a test states rather than a default it inherits. */
export function buildDrawStructureSectionProps(
  overrides: Partial<DrawStructureSectionProps> = {},
): DrawStructureSectionProps {
  // ONE list of pools, cited as the form would hold it. ⚠️ Derived from the event's own
  // rows rather than built beside them: an event with four pools and a `pools` prop holding
  // three is the very drift ADR 20260808 exists to remove, and a test given both could pin
  // `4 pool reservations` off the event while the reconciliation read a different list.
  const event = overrides.event ?? buildDrawStructureEvent()
  return {
    event,
    pools: keepPools(event.pools),
    canEdit: true,
    // **Open by default, and stated rather than defaulted in the component**: the "Nothing
    // set" event has no draw, so the qualifier count is a setting a director may still
    // move. The freeze test asks for the other state explicitly, which is what makes "a
    // cut event refuses the row" a claim a test makes rather than one it inherits.
    qualifiersFreeze: { kind: 'open' },
    // …and the same for the pool set, for the same reason: the "Nothing set" event has no
    // draw, so its pool count is a setting a director may still move. A cut event's frozen
    // row is a state a test asks for.
    poolSetFreeze: { kind: 'open' },
    onChange: () => {},
    onPoolsChange: () => {},
    onGoToBasics: () => {},
    ...overrides,
  }
}
