import type { PoolDraw } from '../../../data/draw'
import { buildEntrant } from '../../../data/seed.factory'
import type { PoolDrawProps } from './pool-draw'
import { buildDrawRounds } from './round-list.factory'

/**
 * Pool A of the seeded round-robin draw: an **odd** pool — `player.1`, `player.4` and
 * `player.5` — playing three rounds of one fixture each (one of them sits out every
 * round; that absence is the bye).
 *
 * Odd on purpose: an even pool's rounds all hold the same number of fixtures, so a
 * renderer that invented a "bye" row would look identical against one.
 */
export function buildPoolDrawView(overrides: Partial<PoolDraw> = {}): PoolDraw {
  return {
    id: 'p-a',
    name: 'Pool A',
    entrants: [
      buildEntrant({ id: 'entry-1', userId: 'u-1', username: 'player.1' }),
      buildEntrant({ id: 'entry-4', userId: 'u-4', username: 'player.4' }),
      buildEntrant({ id: 'entry-5', userId: 'u-5', username: 'player.5' }),
    ],
    rounds: buildDrawRounds(),
    ...overrides,
  }
}

/** Props for `PoolDraw`. */
export function buildPoolDrawProps(
  overrides: Partial<PoolDrawProps> = {},
): PoolDrawProps {
  return { pool: buildPoolDrawView(), ...overrides }
}
