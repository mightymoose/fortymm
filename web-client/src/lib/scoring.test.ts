import { describe, expect, it } from 'vitest'
import {
  compactGames,
  deciderGameNumber,
  firstMatchScoreError,
  illegalScoreReason,
  isDecidedMatch,
  overrunDecider,
  type GamePoints,
} from './scoring'

const game = (
  game_number: number,
  side_1_points: number,
  side_2_points: number,
): GamePoints => ({ game_number, side_1_points, side_2_points })

describe('compactGames', () => {
  it('closes a gap left by an out-of-order clinch', () => {
    // #742: games 1-3 scored, deciding win on game 5, game 4 blank.
    const compacted = compactGames([
      game(1, 11, 2),
      game(2, 11, 2),
      game(3, 11, 2),
      game(5, 11, 2),
    ])
    expect(compacted.map((g) => g.game_number)).toEqual([1, 2, 3, 4])
  })

  it('is identity on an already-contiguous board', () => {
    const compacted = compactGames([game(1, 11, 2), game(2, 11, 2)])
    expect(compacted.map((g) => g.game_number)).toEqual([1, 2])
  })

  it('leaves a fully-scored overrun untouched', () => {
    const games = [
      game(1, 11, 2),
      game(2, 11, 2),
      game(3, 11, 2),
      game(4, 11, 2),
      game(5, 11, 2),
    ]
    expect(compactGames(games).map((g) => g.game_number)).toEqual([
      1, 2, 3, 4, 5,
    ])
  })

  it('renumbers a gappy decided board into a finalize-able one', () => {
    // The predicate score-entry uses: gappy [1,2,3,5] is not decided raw…
    const gappy = [game(1, 11, 2), game(2, 11, 2), game(3, 11, 2), game(5, 11, 2)]
    expect(isDecidedMatch(gappy, 7)).toBe(false)
    // …but its compaction is.
    expect(isDecidedMatch(compactGames(gappy), 7)).toBe(true)
  })

  it('preserves each game score under renumbering', () => {
    const compacted = compactGames([game(3, 11, 7), game(1, 11, 4)])
    expect(compacted).toEqual([game(1, 11, 4), game(2, 11, 7)])
  })
})

describe('illegalScoreReason', () => {
  it.each([
    [11, 9],
    [11, 0],
    [9, 11], // symmetric: order doesn't matter
    [12, 10], // deuce won by exactly 2
    [13, 11],
    [20, 18],
  ])('accepts the legal final score %i–%i', (a, b) => {
    expect(illegalScoreReason(a, b)).toBeNull()
  })

  it.each([
    [11, 11, /tie/i], // tied at/above 11 — the reaching-11 hint doesn't apply
    [5, 5, /at least 11/i], // tied below 11 — point them at the 11 threshold
    [0, 0, /at least 11/i],
    [8, 5, /at least 11/i],
    [10, 9, /at least 11/i],
    [11, 10, /deuce/i], // win-by-1 at deuce — the reported bug
    [10, 11, /deuce/i], // symmetric
    [12, 9, /both sides reach 10/i], // past 11 without a deuce
    [15, 10, /exactly 2/i], // deuce, but won by more than 2
    [13, 10, /exactly 2/i],
  ])('rejects the illegal score %i–%i', (a, b, pattern) => {
    expect(illegalScoreReason(a, b)).toMatch(pattern)
  })
})

describe('isDecidedMatch', () => {
  it('accepts a complete, decided board (3–0 in a BO5)', () => {
    expect(
      isDecidedMatch([game(1, 11, 8), game(2, 11, 6), game(3, 11, 9)], 5),
    ).toBe(true)
  })

  it('rejects an empty board (save banner before any game is saved)', () => {
    expect(isDecidedMatch([], 5)).toBe(false)
  })

  it('rejects a single non-contiguous game (score-entry mid-entry)', () => {
    // score-entry asks "would saving game 3 finish the match?" before games 1–2
    // exist — a lone game 3 is not a decided board.
    expect(isDecidedMatch([game(3, 11, 8)], 5)).toBe(false)
  })

  it('rejects an undecided board (no side reached the target)', () => {
    expect(isDecidedMatch([game(1, 11, 8), game(2, 8, 11)], 3)).toBe(false)
  })

  it('rejects scored games past the decider', () => {
    // Decided at game 2 (side 1 wins twice), game 3 trails the decider.
    expect(
      isDecidedMatch([game(1, 11, 8), game(2, 11, 6), game(3, 8, 11)], 3),
    ).toBe(false)
  })

  it('rejects a game numbered past best_of', () => {
    expect(
      isDecidedMatch([game(1, 11, 8), game(2, 11, 6), game(3, 11, 9)], 1),
    ).toBe(false)
  })

  it('rejects an illegal game score', () => {
    expect(isDecidedMatch([game(1, 11, 8), game(2, 5, 3)], 3)).toBe(false)
  })
})

describe('firstMatchScoreError', () => {
  it('returns null for a complete, decided board', () => {
    expect(
      firstMatchScoreError([game(1, 11, 8), game(2, 11, 6), game(3, 11, 9)], 5),
    ).toBeNull()
  })

  it('explains an undecided board', () => {
    expect(firstMatchScoreError([game(1, 11, 8), game(2, 8, 11)], 5)).toMatch(
      /no side has won 3 games/i,
    )
  })

  it('explains a decider that lands before the last game', () => {
    expect(
      firstMatchScoreError(
        [game(1, 11, 8), game(2, 11, 6), game(3, 8, 11)],
        3,
      ),
    ).toMatch(/before the last game/i)
  })
})

describe('deciderGameNumber', () => {
  it('is null for an empty board', () => {
    expect(deciderGameNumber([], 7)).toBeNull()
  })

  it('is null while no side has clinched', () => {
    expect(deciderGameNumber([game(1, 11, 2), game(2, 2, 11)], 7)).toBeNull()
  })

  it('returns the clinching game for a 4-0 sweep (best of 7)', () => {
    expect(
      deciderGameNumber(
        [game(1, 11, 2), game(2, 11, 2), game(3, 11, 2), game(4, 11, 2)],
        7,
      ),
    ).toBe(4)
  })

  it('returns the last game for a 4-3 that goes the distance', () => {
    const games = [
      game(1, 11, 2),
      game(2, 2, 11),
      game(3, 11, 2),
      game(4, 2, 11),
      game(5, 11, 2),
      game(6, 2, 11),
      game(7, 11, 2),
    ]
    expect(deciderGameNumber(games, 7)).toBe(7)
  })

  it('is gap-tolerant — a single non-clinching game returns null', () => {
    expect(deciderGameNumber([game(3, 11, 9)], 5)).toBeNull()
  })

  it('reports the early decider even when trailing games are present', () => {
    // The overrun board: 4-0 by game 4 with games 5-7 also scored. The decider
    // is unaffected by the (impossible) trailing games.
    const games = [
      game(1, 11, 2),
      game(2, 11, 2),
      game(3, 11, 2),
      game(4, 11, 2),
      game(5, 11, 2),
    ]
    expect(deciderGameNumber(games, 7)).toBe(4)
  })
})

describe('overrunDecider', () => {
  it('is null when the decider is the last scored game (4-0 in four games)', () => {
    const games = [game(1, 11, 2), game(2, 11, 2), game(3, 11, 2), game(4, 11, 2)]
    expect(overrunDecider(games, 7)).toBeNull()
  })

  it('reports the decider when later games are also scored (overrun)', () => {
    const games = [
      game(1, 11, 2),
      game(2, 11, 2),
      game(3, 11, 2),
      game(4, 11, 2),
      game(5, 11, 2),
    ]
    expect(overrunDecider(games, 7)).toBe(4)
  })

  it('is null for an undecided board', () => {
    expect(overrunDecider([game(1, 11, 2), game(2, 2, 11)], 7)).toBeNull()
  })

  it('is null for an empty board', () => {
    expect(overrunDecider([], 7)).toBeNull()
  })

  it('is null for a 4-3 that goes the distance', () => {
    const games = [
      game(1, 11, 2),
      game(2, 2, 11),
      game(3, 11, 2),
      game(4, 2, 11),
      game(5, 11, 2),
      game(6, 2, 11),
      game(7, 11, 2),
    ]
    expect(overrunDecider(games, 7)).toBeNull()
  })
})
