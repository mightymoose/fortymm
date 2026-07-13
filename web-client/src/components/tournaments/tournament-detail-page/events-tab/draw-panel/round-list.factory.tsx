import type { DrawRound } from '../../../data/draw'
import type { RoundListProps } from './round-list'
import { buildFixtureLineView } from './round-list/fixture-line.factory'

/** One round holding one fixture — the shape an ODD round-robin pool's rounds have (the
 * third player sits out), and the smallest thing worth rendering. */
export function buildDrawRound(overrides: Partial<DrawRound> = {}): DrawRound {
  return {
    round: 1,
    fixtures: [buildFixtureLineView()],
    ...overrides,
  }
}

/**
 * The three rounds of an odd (three-player) round-robin pool: `player.1`, `player.4`,
 * `player.5` playing each other once, one fixture a round.
 *
 * Deliberately the odd case — an even pool's rounds all hold the same number of
 * fixtures, so a renderer that quietly invented a "bye" row would look identical.
 */
export function buildDrawRounds(): DrawRound[] {
  return [
    buildDrawRound({
      round: 1,
      fixtures: [
        buildFixtureLineView({
          id: 'fx-a-1',
          a: { kind: 'entrant', name: 'player.1' },
          b: { kind: 'entrant', name: 'player.4' },
        }),
      ],
    }),
    buildDrawRound({
      round: 2,
      fixtures: [
        buildFixtureLineView({
          id: 'fx-a-2',
          a: { kind: 'entrant', name: 'player.1' },
          b: { kind: 'entrant', name: 'player.5' },
        }),
      ],
    }),
    buildDrawRound({
      round: 3,
      fixtures: [
        buildFixtureLineView({
          id: 'fx-a-3',
          a: { kind: 'entrant', name: 'player.4' },
          b: { kind: 'entrant', name: 'player.5' },
        }),
      ],
    }),
  ]
}

/** Props for `RoundList` — the odd pool's three rounds, in Pool A. */
export function buildRoundListProps(
  overrides: Partial<RoundListProps> = {},
): RoundListProps {
  return { rounds: buildDrawRounds(), groupName: 'Pool A', ...overrides }
}
