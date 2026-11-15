import { describe, expect, test } from 'vitest'
import {
  gamesWon,
  illegalGameReason,
  isDecided,
  mayClear,
  nextGame,
  saveRefusal,
  withGame,
  type Games,
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
  const games: Games = [
    [11, 7],
    [9, 11],
  ]

  test('after 11–7, 9–11 in a best of 5, the next game is 3', () => {
    expect(nextGame(games, 5)).toBe(3)
  })

  test('after 11–7, 9–11 in a best of 5, nothing is decided', () => {
    expect(isDecided(games, 5)).toBe(false)
  })

  test('after 11–7, 9–11, each side has won one game', () => {
    expect(gamesWon(games)).toEqual([1, 1])
  })

  test('the first game of a match with nothing saved is game 1', () => {
    expect(nextGame([], 5)).toBe(1)
  })
})

describe('a match with gaps', () => {
  // Games 1 and 3 saved, game 2 empty.
  const gapped: Games = [[11, 7], null, [11, 4]]
  const decided: Games = [[11, 7], null, [11, 4], null, [11, 9]]

  test('the next game is the lowest empty one, game 2', () => {
    expect(nextGame(gapped, 5)).toBe(2)
  })

  test('the games won count every saved game, wherever it sits', () => {
    expect(gamesWon(gapped)).toEqual([2, 0])
  })

  test('games 1, 3 and 5 won in a best of 5 decide it, with games 2 and 4 empty and no next game', () => {
    expect(isDecided(decided, 5)).toBe(true)
    expect(nextGame(decided, 5)).toBeNull()
  })

  test('game 3 may be saved before game 2', () => {
    expect(saveRefusal([[11, 7]], 5, 3, [11, 4])).toBeNull()
  })

  test('an empty game of a match decided with gaps is refused as past the decider', () => {
    expect(saveRefusal(decided, 5, 2, [11, 3])).toEqual({
      reason: 'past-decider',
      message: "The match is already decided; game 2 can't be played.",
    })
  })
})

describe('a decided match', () => {
  const games: Games = [
    [11, 7],
    [11, 5],
    [11, 9],
  ]

  test('3–0 in a best of 5 is decided, with no next game', () => {
    expect(isDecided(games, 5)).toBe(true)
    expect(nextGame(games, 5)).toBeNull()
  })

  test('saving a game 4 after 3–0 in a best of 5 is refused as past the decider', () => {
    expect(saveRefusal(games, 5, 4, [11, 3])).toEqual({
      reason: 'past-decider',
      message: "The match is already decided; game 4 can't be played.",
    })
  })

  test('in a best of 1, one game decides the match', () => {
    expect(isDecided([[8, 11]], 1)).toBe(true)
    expect(nextGame([[8, 11]], 1)).toBeNull()
  })

  test('a 4–3 in a best of 7 is decided', () => {
    const sevenGames: Games = [
      [11, 2],
      [2, 11],
      [11, 2],
      [2, 11],
      [11, 2],
      [2, 11],
      [11, 2],
    ]
    expect(isDecided(sevenGames, 7)).toBe(true)
    expect(gamesWon(sevenGames)).toEqual([4, 3])
  })

  test('each of its saved games may still be corrected, with any legal score', () => {
    for (const game of [1, 2, 3]) expect(saveRefusal(games, 5, game, [4, 11])).toBeNull()
  })
})

describe('saving a game', () => {
  test('a game past the best of is refused', () => {
    expect(saveRefusal([[11, 7]], 3, 4, [11, 4])).toEqual({
      reason: 'past-best-of',
      message: "This match is best of 3; game 4 can't exist.",
    })
  })

  test('game 0 is refused as no game of the match', () => {
    expect(saveRefusal([], 5, 0, [11, 4])?.reason).toBe('past-best-of')
  })

  test('an illegal score for an empty game is refused with its reason', () => {
    expect(saveRefusal([], 5, 1, [11, 10])).toEqual({
      reason: 'illegal',
      message: 'At 10–10 the game enters deuce — the winner must lead by 2.',
    })
  })

  test('an illegal correction of a saved game is refused with its reason', () => {
    expect(saveRefusal([[11, 7]], 5, 1, [12, 9])?.reason).toBe('illegal')
  })

  test('a correction that undoes the decider leaves the match open at the lowest empty game', () => {
    const games: Games = [
      [11, 7],
      [11, 5],
      [11, 9],
    ]
    expect(saveRefusal(games, 5, 3, [9, 11])).toBeNull()
    const corrected = withGame(games, 3, [9, 11])
    expect(isDecided(corrected, 5)).toBe(false)
    expect(nextGame(corrected, 5)).toBe(4)
  })
})

describe('the games with one game set or emptied', () => {
  test('setting game 3 of a match with nothing saved leaves games 1 and 2 empty', () => {
    expect(withGame([], 3, [11, 4])).toEqual([null, null, [11, 4]])
  })

  test('emptying the middle game leaves a gap', () => {
    expect(withGame([[11, 7], [9, 11], [11, 4]], 2, null)).toEqual([[11, 7], null, [11, 4]])
  })

  test('emptying the last saved game drops the empty slots at the end', () => {
    expect(withGame([[11, 7], null, [11, 4]], 3, null)).toEqual([[11, 7]])
  })
})

describe('clearing a game', () => {
  const games: Games = [
    [11, 7],
    [9, 11],
    [11, 5],
  ]

  test('any saved game may be cleared, the highest or not', () => {
    for (const game of [1, 2, 3]) expect(mayClear(games, game)).toBe(true)
  })

  test('a game not saved may not be cleared', () => {
    expect(mayClear(games, 4)).toBe(false)
    expect(mayClear([[11, 7], null, [11, 5]], 2)).toBe(false)
    expect(mayClear([], 1)).toBe(false)
  })

  test('a clear that undecides the match reopens its empty games', () => {
    const decided: Games = [
      [11, 7],
      [11, 5],
      [11, 9],
    ]
    const cleared = withGame(decided, 2, null)
    expect(isDecided(cleared, 5)).toBe(false)
    expect(nextGame(cleared, 5)).toBe(2)
    expect(saveRefusal(cleared, 5, 4, [11, 3])).toBeNull()
  })
})

