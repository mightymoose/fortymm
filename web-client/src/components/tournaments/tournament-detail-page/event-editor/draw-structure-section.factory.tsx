import { buildPool, buildRrThenKoEvent } from '../../data/seed.factory'
import { poolLetter } from '../../data/draw-structure'
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

/** Props for `DrawStructureSection` — the "Nothing set" event above, and a spy-able
 * way back to Basics. */
export function buildDrawStructureSectionProps(
  overrides: Partial<DrawStructureSectionProps> = {},
): DrawStructureSectionProps {
  return {
    event: buildDrawStructureEvent(),
    onGoToBasics: () => {},
    ...overrides,
  }
}
