import { describe, expect, test } from 'vitest'
import {
  decidingGame,
  gamesWon,
  illegalGameReason,
  isDecided,
  mayClear,
  nextGame,
  saveRefusal,
  type Score,
} from './scoring.ts'

// The cases the core's rules (task C) will take as golden vectors, after
// fortymm-real's lib/scoring.test.ts and score-pad/validate-game-score.test.ts.

describe('a game score', () => {
  test.each<Score>([
    [11, 0],
    [11, 1],
    [11, 2],
    [11, 3],
    [11, 4],
    [11, 5],
    [11, 6],
    [11, 7],
    [11, 8],
    [11, 9],
    [9, 11],
    [12, 10],
    [13, 11],
    [20, 18],
    [99, 97],
  ])('%i–%i is legal', (a, b) => {
    expect(illegalGameReason([a, b])).toBeNull()
  })

  test.each<[number, number, string]>([
    [11, 10, 'At 10–10 the game enters deuce — the winner must lead by 2.'],
    [10, 11, 'At 10–10 the game enters deuce — the winner must lead by 2.'],
    [10, 10, 'The winning side must reach at least 11 points.'],
    [0, 0, 'The winning side must reach at least 11 points.'],
    [10, 9, 'The winning side must reach at least 11 points.'],
    [11, 11, 'A game cannot end in a tie.'],
    [12, 9, 'A game can only go past 11 once both sides reach 10.'],
    [13, 10, 'In a deuce game the winner leads by exactly 2 points.'],
    [15, 10, 'In a deuce game the winner leads by exactly 2 points.'],
    [100, 98, 'Each side can score at most 99 points.'],
    [-1, 11, 'Enter each score as a whole number from 0 to 99.'],
    [11.5, 7, 'Enter each score as a whole number from 0 to 99.'],
  ])('%i–%i is refused: %s', (a, b, reason) => {
    expect(illegalGameReason([a, b])).toBe(reason)
  })
})

describe('a match under way', () => {
  const games: Score[] = [
    [11, 7],
    [9, 11],
  ]

  test('after 11–7, 9–11 in a best of 5, the next game is 3', () => {
    expect(nextGame(games, 5)).toBe(3)
  })

  test('after 11–7, 9–11 in a best of 5, nothing is decided', () => {
    expect(decidingGame(games, 5)).toBeNull()
    expect(isDecided(games, 5)).toBe(false)
  })

  test('after 11–7, 9–11, each side has won one game', () => {
    expect(gamesWon(games)).toEqual([1, 1])
  })

  test('the first game of a match with nothing saved is game 1', () => {
    expect(nextGame([], 5)).toBe(1)
  })
})

describe('a decided match', () => {
  const games: Score[] = [
    [11, 7],
    [11, 5],
    [11, 9],
  ]

  test('3–0 in a best of 5 is decided at game 3', () => {
    expect(decidingGame(games, 5)).toBe(3)
  })

  test('3–0 in a best of 5 is decided, with no next game', () => {
    expect(isDecided(games, 5)).toBe(true)
    expect(nextGame(games, 5)).toBeNull()
  })

  test('saving a game 4 after 3–0 in a best of 5 is refused as past the decider', () => {
    expect(saveRefusal(games, 5, 4, [11, 3])).toEqual({
      reason: 'past-decider',
      message: "The match was already decided at game 3; game 4 can't be played.",
    })
  })

  test('in a best of 1, one game decides the match', () => {
    expect(decidingGame([[8, 11]], 1)).toBe(1)
    expect(nextGame([[8, 11]], 1)).toBeNull()
  })

  test('a 4–3 in a best of 7 is decided at game 7', () => {
    const sevenGames: Score[] = [
      [11, 2],
      [2, 11],
      [11, 2],
      [2, 11],
      [11, 2],
      [2, 11],
      [11, 2],
    ]
    expect(decidingGame(sevenGames, 7)).toBe(7)
    expect(gamesWon(sevenGames)).toEqual([4, 3])
  })
})

describe('saving a game', () => {
  test('saving game 3 when only game 1 is saved is refused: game 2 comes first', () => {
    expect(saveRefusal([[11, 7]], 5, 3, [11, 4])).toEqual({
      reason: 'non-contiguous',
      message: 'Save game 2 before game 3.',
    })
  })

  test('saving the next game is allowed', () => {
    expect(saveRefusal([[11, 7]], 5, 2, [11, 4])).toBeNull()
  })

  test('correcting game 1 when games 1 to 3 are saved is allowed', () => {
    const games: Score[] = [
      [11, 7],
      [7, 11],
      [11, 9],
    ]
    expect(saveRefusal(games, 5, 1, [12, 10])).toBeNull()
  })

  test('a game past the best of is refused', () => {
    const games: Score[] = [
      [11, 7],
      [7, 11],
      [11, 9],
    ]
    expect(saveRefusal(games, 3, 4, [11, 4])).toEqual({
      reason: 'past-best-of',
      message: "This match is best of 3; game 4 can't exist.",
    })
  })

  test('game 0 is refused as no game of the match', () => {
    expect(saveRefusal([], 5, 0, [11, 4])?.reason).toBe('past-best-of')
  })

  test('an illegal score for the next game is refused with its reason', () => {
    expect(saveRefusal([], 5, 1, [11, 10])).toEqual({
      reason: 'illegal',
      message: 'At 10–10 the game enters deuce — the winner must lead by 2.',
    })
  })
})

describe('correcting a saved game changes who decides the match', () => {
  test('a correction that undoes the decider leaves the match open at the next game', () => {
    const games: Score[] = [
      [11, 7],
      [11, 5],
      [11, 9],
    ]
    expect(saveRefusal(games, 5, 3, [9, 11])).toBeNull()
    const corrected = games.with(2, [9, 11])
    expect(isDecided(corrected, 5)).toBe(false)
    expect(nextGame(corrected, 5)).toBe(4)
  })

  test('a correction that decides the match before a later saved game is refused, so no saved game is lost', () => {
    // 2–1 after three games, decided 3–1 at game 4. Making game 2 a win for
    // the first side would decide the match at game 3, leaving the saved
    // game 4 past the decider.
    const games: Score[] = [
      [11, 7],
      [9, 11],
      [11, 5],
      [11, 3],
    ]
    expect(saveRefusal(games, 5, 2, [11, 9])).toEqual({
      reason: 'past-decider',
      message:
        'The match is already decided at game 3 — clear the games after it before saving this score.',
    })
  })

  test('a correction of the deciding game that keeps it deciding is allowed', () => {
    const games: Score[] = [
      [11, 7],
      [9, 11],
      [11, 5],
      [11, 3],
    ]
    expect(saveRefusal(games, 5, 4, [13, 11])).toBeNull()
  })
})

describe('clearing a game', () => {
  const games: Score[] = [
    [11, 7],
    [9, 11],
    [11, 5],
  ]

  test('the highest saved game may be cleared', () => {
    expect(mayClear(games, 3)).toBe(true)
  })

  test('a saved game below the highest may not be cleared', () => {
    expect(mayClear(games, 2)).toBe(false)
  })

  test('a game not saved may not be cleared', () => {
    expect(mayClear(games, 4)).toBe(false)
    expect(mayClear([], 1)).toBe(false)
  })
})
