import { describe, expect, it } from 'vitest'
import { matchWinner, parseGameScore, reviewBoard, tally, type GamePoints } from './board'

function kind(a: string, b: string): string {
  return parseGameScore(a, b).kind
}

describe('parseGameScore', () => {
  it('is empty when both scores are blank', () => {
    expect(parseGameScore('', '  ')).toEqual({ kind: 'empty' })
  })

  it('is partial when one score is blank', () => {
    expect(kind('11', '')).toBe('partial')
    expect(kind('', '7')).toBe('partial')
  })

  it.each([
    ['abc', '7'],
    ['11', '-1'],
    ['100', '98'],
    ['1.5', '11'],
    ['x', ''],
  ])('is malformed for %s and %s', (a, b) => {
    expect(kind(a, b)).toBe('malformed')
  })

  it.each([
    ['11', '0', 0],
    ['11', '9', 0],
    ['9', '11', 1],
    ['12', '10', 0],
    ['10', '12', 1],
    ['25', '23', 0],
    [' 11 ', '07', 0],
  ] as const)('takes %s–%s as a legal game', (a, b, winner) => {
    expect(parseGameScore(a, b)).toEqual({
      kind: 'legal',
      points: [Number(a), Number(b)],
      winner,
    })
  })

  it.each([
    ['11', '10', 'At 10–10 the game goes to deuce, so the winner needs a 2-point lead. 11–10 can’t be a final score.'],
    ['10', '11', 'At 10–10 the game goes to deuce, so the winner needs a 2-point lead. 10–11 can’t be a final score.'],
    ['10', '8', 'A game ends when a player reaches 11. 10–8 can’t be a final score.'],
    ['0', '0', 'A game can’t end level. 0–0 can’t be a final score.'],
    ['12', '12', 'A game can’t end level. 12–12 can’t be a final score.'],
    ['12', '9', 'The game ends as soon as a player reaches 11 with a 2-point lead. 12–9 can’t be a final score.'],
    ['13', '10', 'After deuce the game ends at a 2-point lead. 13–10 can’t be a final score.'],
    ['13', '12', 'After deuce the game ends at a 2-point lead. 13–12 can’t be a final score.'],
  ])('refuses %s–%s with its reason', (a, b, reason) => {
    expect(parseGameScore(a, b)).toEqual({ kind: 'illegal', reason })
  })
})

const A: GamePoints = [11, 5]
const B: GamePoints = [7, 11]

describe('tally', () => {
  it('counts the games each side won, skipping empty slots', () => {
    expect(tally([A, null, B, A])).toEqual([2, 1])
    expect(tally([])).toEqual([0, 0])
  })
})

describe('matchWinner', () => {
  it('is the side that won more games', () => {
    expect(matchWinner([A, B, A])).toBe(0)
    expect(matchWinner([B, A, B, B])).toBe(1)
  })
})

describe('reviewBoard', () => {
  it('decides a best of 1 in its one game', () => {
    expect(reviewBoard([B], 1)).toEqual({
      kind: 'decided',
      decidedAtGame: 1,
      winner: 1,
      games: [B],
      tally: [0, 1],
    })
  })

  it('needs one game to win a best of 1', () => {
    expect(reviewBoard([null], 1)).toEqual({ kind: 'undecided', tally: [0, 0], gamesToWin: 1 })
  })

  it('decides a best of 3 in two games', () => {
    expect(reviewBoard([A, A, null], 3)).toEqual({
      kind: 'decided',
      decidedAtGame: 2,
      winner: 0,
      games: [A, A],
      tally: [2, 0],
    })
  })

  it('decides a best of 5 for the second player', () => {
    expect(reviewBoard([A, B, B, B, null], 5)).toEqual({
      kind: 'decided',
      decidedAtGame: 4,
      winner: 1,
      games: [A, B, B, B],
      tally: [1, 3],
    })
  })

  it('decides a best of 7 that goes the distance', () => {
    expect(reviewBoard([A, B, A, B, A, B, A], 7)).toMatchObject({
      kind: 'decided',
      decidedAtGame: 7,
      winner: 0,
      tally: [4, 3],
    })
  })

  it('is undecided while nobody has won enough games', () => {
    expect(reviewBoard([A, B, null, null, null], 5)).toEqual({
      kind: 'undecided',
      tally: [1, 1],
      gamesToWin: 3,
    })
    expect(reviewBoard([null, null, null, null, null, null, null], 7)).toEqual({
      kind: 'undecided',
      tally: [0, 0],
      gamesToWin: 4,
    })
  })

  it('names the games filled in after the decider', () => {
    expect(reviewBoard([A, A, A, null, B], 5)).toEqual({ kind: 'overrun', decidedAtGame: 3, extraGames: [5] })
    expect(reviewBoard([A, A, B], 3)).toEqual({ kind: 'overrun', decidedAtGame: 2, extraGames: [3] })
    expect(reviewBoard([B, B, B, B, A, B, A], 7)).toEqual({ kind: 'overrun', decidedAtGame: 4, extraGames: [5, 6, 7] })
  })
})
