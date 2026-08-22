import type { GroupDraw } from '../../../data/draw'
import { buildEntrant } from '../../../data/seed.factory'
import type { GroupDrawProps } from './group-draw'
import { buildDrawRounds } from './round-list.factory'

/**
 * Group A of the seeded round-robin draw: an **odd** group — `player.1`, `player.4` and
 * `player.5` — playing three rounds of one fixture each (one of them sits out every
 * round; that absence is the bye).
 *
 * Odd on purpose: an even group's rounds all hold the same number of fixtures, so a
 * renderer that invented a "bye" row would look identical against one.
 */
export function buildGroupDrawView(overrides: Partial<GroupDraw> = {}): GroupDraw {
  return {
    id: 'grp-a',
    label: 'Group A',
    entrants: [
      buildEntrant({ id: 'entry-1', userId: 'u-1', username: 'player.1' }),
      buildEntrant({ id: 'entry-4', userId: 'u-4', username: 'player.4' }),
      buildEntrant({ id: 'entry-5', userId: 'u-5', username: 'player.5' }),
    ],
    rounds: buildDrawRounds(),
    ...overrides,
  }
}

/** Props for `GroupDraw`. */
export function buildGroupDrawProps(
  overrides: Partial<GroupDrawProps> = {},
): GroupDrawProps {
  return { group: buildGroupDrawView(), ...overrides }
}
