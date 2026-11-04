import { describe, expect, it } from 'vitest'
import type { MatchResult } from '../signing/result'
import { demoMatch, matchFor, viewerOf } from './demoMatches'

const A = { id: 'c4a8f6a2-1f0e-4a63-8d2e-7f5b9e1c3d42', name: 'excited egret 387' }
const B = { id: '9d3b1f40-7a2c-4e85-b6d1-3c8e0f5a2b97', name: 'quiet quail 640' }
const OPPONENT = '6f1d2c43-8b5e-4a0f-9c71-2e4b8d0a5f13'

function result(players: [string, string], overrides: Partial<MatchResult> = {}): MatchResult {
  return {
    match: demoMatch('demo', A).uuid,
    bestOf: 5,
    rated: false,
    players,
    games: [],
    ending: 'completed',
    replaces: null,
    ...overrides,
  } as MatchResult
}

describe('matchFor', () => {
  it('is the demo match with no result', () => {
    expect(matchFor('demo', A, null)).toEqual(demoMatch('demo', A))
  })

  it('keeps the players of a result that names the viewer', () => {
    const match = matchFor('demo', A, result([A.id, OPPONENT]))!

    expect(match.players).toEqual([A, { id: OPPONENT, name: 'brave badger 214' }])
    expect(viewerOf(match, A.id)).toEqual({ role: 'player', side: 0 })
  })

  it('stands the viewer in for the opponent of another device’s result', () => {
    const match = matchFor('demo', B, result([A.id, OPPONENT]))!

    expect(match.players).toEqual([{ id: A.id, name: 'Player 1' }, B])
    expect(viewerOf(match, B.id)).toEqual({ role: 'player', side: 1 })
  })

  it('finds the viewer again in a result they submitted from another device’s', () => {
    const match = matchFor('demo', A, result([A.id, B.id]))!

    expect(match.players).toEqual([A, { id: B.id, name: 'Player 2' }])
    expect(viewerOf(match, A.id)).toEqual({ role: 'player', side: 0 })
  })

  it('makes the viewer a spectator of a result between two others', () => {
    const spectated = demoMatch('demo-spectator', A)
    const ids = spectated.players.map((player) => player.id) as [string, string]
    const match = matchFor('demo-spectator', A, result(ids, { match: spectated.uuid }))!

    expect(match.players).toEqual(spectated.players)
    expect(viewerOf(match, A.id)).toEqual({ role: 'spectator' })
  })

  it('stands nobody in for a spectated match', () => {
    const spectated = demoMatch('demo-spectator', A)
    const match = matchFor('demo-spectator', B, result([A.id, OPPONENT], { match: spectated.uuid }))!

    expect(viewerOf(match, B.id)).toEqual({ role: 'spectator' })
  })

  it('is null for another match’s result', () => {
    expect(matchFor('demo', A, result([A.id, OPPONENT], { match: demoMatch('demo-spectator', A).uuid }))).toBeNull()
  })
})
