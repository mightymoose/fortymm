import { describe, expect, it } from 'vitest'
import {
  firstMatchScoreError,
  illegalScoreReason,
  isDecidedMatch,
  type GamePoints,
} from './scoring'

const game = (
  game_number: number,
  side_1_points: number,
  side_2_points: number,
): GamePoints => ({ game_number, side_1_points, side_2_points })

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
