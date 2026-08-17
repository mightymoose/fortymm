import { buildReservation, buildRrThenKoEvent } from '../../data/seed.factory'
import { groupLetter } from '../../data/draw-structure'
import type { TournamentEvent } from '../../data/types'
import type { DrawStructureSectionProps } from './draw-structure-section'

/**
 * The reference's **"Nothing set"** state
 * (`docs/designs/rr-then-ko-draw-structure/nothing-set.png`): a two-stage event capped
 * at **32 players** with **four** reservations, so the tab derives 4 groups of 8 and
 * 2 qualifiers apiece, and every setting is the system's.
 *
 * ⚠️ **Both numbers are stated here rather than inherited**, because two of the four
 * source sentences read them out — `32 players ÷ 4 groups` and
 * `4 reservations · today's behaviour`. A cap or a reservation count that moved under
 * this factory would move the copy the tests pin, and the red would look like a copy
 * bug.
 *
 * The split is deliberately **even** (32 ÷ 4 = 8), so the uneven case is something a
 * test asks for rather than something it gets by accident.
 */
export function buildDrawStructureEvent(
  overrides: Partial<Omit<TournamentEvent, 'entered'>> = {},
): TournamentEvent {
  return buildRrThenKoEvent({
    maxPlayers: 32,
    reservations: Array.from({ length: 4 }, (_, i) =>
      buildReservation({
        id: `res-${groupLetter(i).toLowerCase()}`,
        name: `Reservation ${groupLetter(i)}`,
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
