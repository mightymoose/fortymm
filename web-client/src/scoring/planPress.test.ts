import { describe, expect, it } from 'vitest'
import { parseGameScore, type GamePoints } from './board'
import type { Viewer } from './demoMatches'
import { planPress } from './planPress'
import type { Board } from './scratchpad'

const ann = { playerId: 'ann', name: 'excited egret 387' }
const player: Viewer = { role: 'player', side: 0 }
const spectator: Viewer = { role: 'spectator' }

function board(games: Record<number, GamePoints>): Board {
  return {
    games: Object.fromEntries(Object.entries(games).map(([game, points]) => [game, { points, savedBy: ann }])),
    submission: { phase: 'open' },
  }
}

describe('planPress', () => {
  it('is disabled until the score is legal', () => {
    expect(planPress(board({}), player, 1, parseGameScore('', ''), 5)).toEqual({ kind: 'disabled' })
    expect(planPress(board({}), player, 1, parseGameScore('11', ''), 5)).toEqual({ kind: 'disabled' })
    expect(planPress(board({}), player, 1, parseGameScore('11', '10'), 5)).toEqual({ kind: 'disabled' })
  })

  it('saves and moves to the next empty game after this one', () => {
    expect(planPress(board({ 2: [11, 3] }), player, 1, parseGameScore('11', '4'), 5)).toEqual({
      kind: 'save',
      points: [11, 4],
      next: 3,
    })
  })

  it('stays when no empty game follows', () => {
    expect(planPress(board({ 1: [11, 3] }), player, 5, parseGameScore('3', '11'), 5)).toMatchObject({
      kind: 'save',
      next: null,
    })
  })




  it('only saves for a spectator, and stays once the match is decided', () => {
    expect(planPress(board({ 1: [11, 1], 2: [11, 2] }), spectator, 3, parseGameScore('11', '3'), 5)).toEqual({
      kind: 'save',
      points: [11, 3],
      next: null,
    })
  })

  it('saves an overrun board rather than submitting it', () => {
    expect(planPress(board({ 1: [11, 1], 2: [11, 2], 5: [4, 11] }), player, 3, parseGameScore('11', '3'), 5)).toEqual({
      kind: 'save',
      points: [11, 3],
      next: null,
    })
  })

  it('is disabled on a submitted board', () => {
    const submitted: Board = {
      ...board({ 1: [11, 1] }),
      submission: { phase: 'submitted', by: 'ann', games: [[11, 1]], submittedAt: 'now' },
    }

    expect(planPress(submitted, player, 2, parseGameScore('11', '3'), 3)).toEqual({ kind: 'disabled' })
  })
})
