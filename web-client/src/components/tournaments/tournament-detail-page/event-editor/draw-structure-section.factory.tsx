import { buildReservation, buildRrThenKoEvent } from '../../data/seed.factory'
import { groupLetter } from '../../data/draw-structure'
import type { TournamentEvent } from '../../data/types'
import type { DrawStructureSectionProps } from './draw-structure-section'

/**
 * The default state: a two-stage event capped at **20 players** with **four**
 * reservations, and every setting the system's, so the default divisor of five derives
 * 4 groups of 5 and 2 qualifiers apiece (#1386).
 *
 * ⚠️ **The cap is stated here rather than inherited**, because three of the four source
 * sentences read it out — `20 players ÷ about 5 per group` and `20 players ÷ 4 groups`
 * among them. A cap that moved under this factory would move the copy the tests pin,
 * and the red would look like a copy bug. The reservation count no longer reaches the
 * derivation; the preview's `Reservations` fact is its one reader.
 *
 * The split is deliberately **even** (20 ÷ 5 = 4), so the uneven case is something a
 * test asks for rather than something it gets by accident.
 */
export function buildDrawStructureEvent(
  overrides: Partial<Omit<TournamentEvent, 'entered'>> = {},
): TournamentEvent {
  return buildRrThenKoEvent({
    maxPlayers: 20,
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

/** Props for `DrawStructureSection` — the default event above, and a spy-able
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
