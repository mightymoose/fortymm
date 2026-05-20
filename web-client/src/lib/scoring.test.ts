import { describe, expect, it } from 'vitest'
import { illegalScoreReason } from './scoring'

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
    [11, 11, /tie/i],
    [0, 0, /tie/i],
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
