import { describe, expect, it } from 'vitest'
import { parseGameScore } from './board'
import type { Viewer } from './demoMatches'
import { planPress } from './planPress'

const player: Viewer = { role: 'player', side: 0 }
const spectator: Viewer = { role: 'spectator' }

describe('planPress', () => {
  it('is disabled until the score is legal', () => {
    expect(planPress([], player, 1, parseGameScore('', ''), 5)).toEqual({ kind: 'disabled' })
    expect(planPress([], player, 1, parseGameScore('11', ''), 5)).toEqual({ kind: 'disabled' })
    expect(planPress([], player, 1, parseGameScore('11', '10'), 5)).toEqual({ kind: 'disabled' })
  })

  it('saves and moves to the next empty game', () => {
    expect(planPress([[11, 3]], player, 2, parseGameScore('11', '4'), 5)).toEqual({
      kind: 'save',
      points: [11, 4],
      next: 3,
    })
  })

  it('moves past the entered games when an earlier game changes', () => {
    expect(planPress([[11, 3], [3, 11]], player, 1, parseGameScore('11', '5'), 5)).toMatchObject({
      kind: 'save',
      next: 3,
    })
  })

  it('stays when no empty game follows', () => {
    const games = [[11, 3], [3, 11], [11, 3], [3, 11]] as [number, number][]
    expect(planPress(games, spectator, 5, parseGameScore('3', '11'), 5)).toMatchObject({ kind: 'save', next: null })
  })

  it('submits when a player’s score decides the match', () => {
    expect(planPress([[11, 5], [8, 11], [11, 9]], player, 4, parseGameScore('13', '11'), 5)).toEqual({
      kind: 'submit',
      games: [[11, 5], [8, 11], [11, 9], [13, 11]],
      winner: 0,
    })
  })

  it('submits a decided board with nothing new to save', () => {
    const decided: [number, number][] = [[11, 1], [11, 2], [11, 3]]

    expect(planPress(decided, player, 1, parseGameScore('11', '1'), 5)).toMatchObject({ kind: 'submit' })
    expect(planPress(decided, player, 4, parseGameScore('', ''), 5)).toMatchObject({ kind: 'submit' })
  })

  it('submits the typed score of a changed game', () => {
    const decided: [number, number][] = [[11, 1], [11, 2], [11, 3]]

    expect(planPress(decided, player, 2, parseGameScore('11', '9'), 5)).toMatchObject({
      kind: 'submit',
      games: [[11, 1], [11, 9], [11, 3]],
    })
  })

  it('is disabled rather than submitting while the score being typed isn’t legal', () => {
    expect(planPress([[11, 1], [11, 2], [11, 3]], player, 1, parseGameScore('11', ''), 5)).toEqual({ kind: 'disabled' })
  })

  it('only saves for a spectator, and stays once the match is decided', () => {
    expect(planPress([[11, 1], [11, 2]], spectator, 3, parseGameScore('11', '3'), 5)).toEqual({
      kind: 'save',
      points: [11, 3],
      next: null,
    })
  })

  it('saves an overrun board rather than submitting it', () => {
    const games: [number, number][] = [[11, 1], [1, 11], [11, 2], [11, 3]]
    expect(planPress(games, player, 2, parseGameScore('11', '4'), 5)).toEqual({
      kind: 'save',
      points: [11, 4],
      next: null,
    })
  })
})
