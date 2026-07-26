import type {
  DrawRound,
  DrawState,
  FixtureSide,
} from '../../../data/draw'
import type { BracketProps } from './bracket'
import {
  buildFixtureLineView,
  buildFixtureMatch,
} from './round-list/fixture-line.factory'

/** A named side — the ordinary "seed N sits here" case, written as the read model's
 * `entrant` variant (the wire's seed number is not on a `FixtureSide`, only the name is). */
const named = (name: string): FixtureSide => ({ kind: 'entrant', name })

/** The un-decided side — the feeding fixture has not been played. **Never a bye**: a bye
 * is the absence of a whole fixture (ADR-0786), which is why no builder here emits one. */
const tbd: FixtureSide = { kind: 'tbd' }

/**
 * A **two-entrant** single-elim draw: the bracket is just its Final. One round, one
 * fixture, both seeds named — the smallest legal single-elim (`N < 2` is refused at the
 * cut, ADR-0785).
 */
export function buildTwoEntrantRounds(): DrawRound[] {
  return [
    {
      round: 1,
      fixtures: [
        buildFixtureLineView({
          id: 'se2-final',
          position: 1,
          a: named('player.1'),
          b: named('player.2'),
        }),
      ],
    },
  ]
}

/**
 * An **eight-entrant** single-elim draw, **cut but not yet live** — the state a director
 * reviews before go-live. Round 1 (the quarterfinals) holds all four seeded pairings by
 * standard recursive seeding (`[1,8,5,4,3,6,7,2]`); the semifinals and final are still
 * `TBD` on both sides, waiting on those feeders. Nothing has materialized, so no card
 * links to a match.
 */
export function buildEightEntrantRounds(): DrawRound[] {
  return [
    {
      round: 1,
      fixtures: [
        buildFixtureLineView({
          id: 'se8-qf-1',
          position: 1,
          a: named('player.1'),
          b: named('player.8'),
        }),
        buildFixtureLineView({
          id: 'se8-qf-2',
          position: 2,
          a: named('player.5'),
          b: named('player.4'),
        }),
        buildFixtureLineView({
          id: 'se8-qf-3',
          position: 3,
          a: named('player.3'),
          b: named('player.6'),
        }),
        buildFixtureLineView({
          id: 'se8-qf-4',
          position: 4,
          a: named('player.7'),
          b: named('player.2'),
        }),
      ],
    },
    {
      round: 2,
      fixtures: [
        buildFixtureLineView({ id: 'se8-sf-1', position: 1, a: tbd, b: tbd }),
        buildFixtureLineView({ id: 'se8-sf-2', position: 2, a: tbd, b: tbd }),
      ],
    },
    {
      round: 3,
      fixtures: [
        buildFixtureLineView({ id: 'se8-final', position: 1, a: tbd, b: tbd }),
      ],
    },
  ]
}

/**
 * An **eight-entrant** single-elim draw **in progress**: the quarterfinals have played out
 * (each a completed match), their winners are seated onto the semifinal cards (which are
 * now live matches), and the final still waits on both semifinals.
 *
 * This is the render state that proves *progression is legible* — a round-1 winner
 * (`player.1`, `player.5`, `player.3`, `player.7`) reappears, by name, one column along —
 * and that a materialized card carries its match link and status.
 */
export function buildEightEntrantLiveRounds(): DrawRound[] {
  return [
    {
      round: 1,
      fixtures: [
        buildFixtureLineView({
          id: 'se8-qf-1',
          position: 1,
          a: named('player.1'),
          b: named('player.8'),
          match: buildFixtureMatch({ id: 'm-qf-1', status: 'completed' }),
        }),
        buildFixtureLineView({
          id: 'se8-qf-2',
          position: 2,
          a: named('player.5'),
          b: named('player.4'),
          match: buildFixtureMatch({ id: 'm-qf-2', status: 'completed' }),
        }),
        buildFixtureLineView({
          id: 'se8-qf-3',
          position: 3,
          a: named('player.3'),
          b: named('player.6'),
          match: buildFixtureMatch({ id: 'm-qf-3', status: 'completed' }),
        }),
        buildFixtureLineView({
          id: 'se8-qf-4',
          position: 4,
          a: named('player.7'),
          b: named('player.2'),
          match: buildFixtureMatch({ id: 'm-qf-4', status: 'completed' }),
        }),
      ],
    },
    {
      round: 2,
      fixtures: [
        buildFixtureLineView({
          id: 'se8-sf-1',
          position: 1,
          a: named('player.1'),
          b: named('player.5'),
          match: buildFixtureMatch({ id: 'm-sf-1', status: 'in_progress' }),
        }),
        buildFixtureLineView({
          id: 'se8-sf-2',
          position: 2,
          a: named('player.3'),
          b: named('player.7'),
          match: buildFixtureMatch({ id: 'm-sf-2', status: 'in_progress' }),
        }),
      ],
    },
    {
      round: 3,
      fixtures: [
        buildFixtureLineView({ id: 'se8-final', position: 1, a: tbd, b: tbd }),
      ],
    },
  ]
}

/**
 * A **five-entrant** single-elim draw, **cut but not yet live** — the bracket that best
 * shows byes. Padded to eight, the top three seeds draw byes, so round 1 (the
 * quarterfinals) holds a single real fixture (`player.5 vs player.4`); the other three
 * quarterfinals are absent (a bye is absence, ADR-0786).
 *
 * The byed seeds appear **already seated** one column along: `player.1` sits on a semifinal
 * opposite the `TBD` that the lone quarterfinal will fill, and the all-bye semifinal is a
 * fully-known `player.3 vs player.2`. Nothing here is a "bye" row — the byes read as the
 * missing round-1 cards and the seeds sitting early.
 */
export function buildFiveEntrantRounds(): DrawRound[] {
  return [
    {
      round: 1,
      fixtures: [
        buildFixtureLineView({
          id: 'se5-qf',
          position: 1,
          a: named('player.5'),
          b: named('player.4'),
        }),
      ],
    },
    {
      round: 2,
      fixtures: [
        buildFixtureLineView({
          id: 'se5-sf-1',
          position: 1,
          a: named('player.1'),
          b: tbd,
        }),
        buildFixtureLineView({
          id: 'se5-sf-2',
          position: 2,
          a: named('player.3'),
          b: named('player.2'),
        }),
      ],
    },
    {
      round: 3,
      fixtures: [
        buildFixtureLineView({ id: 'se5-final', position: 1, a: tbd, b: tbd }),
      ],
    },
  ]
}

/**
 * A single-elim `DrawState`, defaulting to the **eight-entrant, cut-but-not-live** bracket
 * — a realistic, non-degenerate scenario a `bare` build renders meaningfully. `pools: []`
 * because a single-elim draw is entirely un-pooled; pass `unpooled` (e.g.
 * `buildFiveEntrantRounds()`, `buildEightEntrantLiveRounds()`) for the other shapes.
 */
export function buildSingleElimDrawState(
  overrides: Partial<Extract<DrawState, { kind: 'drawn' }>> = {},
): DrawState {
  return {
    kind: 'drawn',
    pools: [],
    unpooled: buildEightEntrantRounds(),
    ...overrides,
  }
}

/** Props for `Bracket` — the eight-entrant, cut-but-not-live bracket by default. */
export function buildBracketProps(
  overrides: Partial<BracketProps> = {},
): BracketProps {
  return { rounds: buildEightEntrantRounds(), ...overrides }
}
