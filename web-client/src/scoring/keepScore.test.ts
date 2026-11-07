import { describe, expect, it } from 'vitest'
import type { MatchDetail, MatchStatus } from '../pages/matches/browse/match'
import { keepScoreTarget } from './keepScore'
import { apiMatch } from './matches'
import { readFragment, type Fragment } from './fragment'

const ID = '0193f1a2-0000-7000-8000-000000000001'
const PLAYERS = ['0193f1a2-0000-7000-8000-0000000000a0', '0193f1a2-0000-7000-8000-0000000000a1'] as const
const HEAD = new Uint8Array(32).fill(7)
const AT = 1_793_000_000
const signed = { signedBy: 0, signedAt: '2026-11-05T18:41:00Z' } as const

function detail(status: MatchStatus, games: MatchDetail['games'], bestOf: MatchDetail['bestOf'] = 3): MatchDetail {
  return {
    id: ID,
    bestOf,
    rated: true,
    players: [
      { id: PLAYERS[0], name: 'Wei Chen', you: true },
      { id: PLAYERS[1], name: 'Meera Okafor', you: false },
    ],
    games,
    retiredBy: null,
    startedAt: '2026-11-05T18:00:00Z',
    status,
    history: [],
    resultHash: status.kind === 'new' || status.kind === 'live' ? null : HEAD,
  }
}

// The game the target opens, and the draft its hash holds, as the scoring
// route reads it.
function opened(match: MatchDetail) {
  const target = keepScoreTarget(match, AT)
  if (!target) return null
  const fragment = readFragment(target.hash, apiMatch(ID, match.bestOf, match.rated, PLAYERS))
  expect(fragment?.kind).toBe('draft')
  const { result, issuedAt } = fragment as Extract<Fragment, { kind: 'draft' }>
  expect(issuedAt).toBe(AT)
  expect(result.players).toEqual(PLAYERS)
  return { gameNumber: target.gameNumber, games: result.games, replaces: result.replaces }
}

describe('keepScoreTarget', () => {
  it('opens game 1 of a new match with no games, as Start does', () => {
    expect(opened(detail({ kind: 'new' }, []))).toEqual({ gameNumber: '1', games: [], replaces: null })
  })

  it('opens a live match after its board’s finished games, without the game in play', () => {
    expect(opened(detail({ kind: 'live' }, [[11, 5], [6, 4]]))).toEqual({
      gameNumber: '2',
      games: [[11, 5]],
      replaces: null,
    })
  })

  it('opens the last game once every game has a score', () => {
    expect(opened(detail({ kind: 'live' }, [[11, 5], [5, 11], [11, 9]]))?.gameNumber).toBe('3')
  })

  it('corrects an awaiting result, naming it in replaces', () => {
    expect(opened(detail({ kind: 'awaiting', ...signed }, [[11, 5], [11, 7]]))).toEqual({
      gameNumber: '3',
      games: [[11, 5], [11, 7]],
      replaces: HEAD,
    })
  })

  it('corrects a disputed result, naming the head in replaces', () => {
    const status: MatchStatus = { kind: 'disputed', ...signed, theirGames: [[11, 5]] }
    expect(opened(detail(status, [[5, 11], [5, 11]]))?.replaces).toEqual(HEAD)
  })

  it('opens nothing for a final match', () => {
    const status: MatchStatus = { kind: 'final', acceptedAt: '2026-11-05T19:00:00Z', approvedBy: [0, 1], overrideReason: null }
    expect(keepScoreTarget(detail(status, [[11, 5], [11, 7]]), AT)).toBeNull()
  })

  it('opens nothing for a match whose players were merged into one', () => {
    const match = detail({ kind: 'live' }, [[11, 5]])
    const merged: MatchDetail = { ...match, players: [match.players[0], { ...match.players[1], id: PLAYERS[0] }] }
    expect(keepScoreTarget(merged, AT)).toBeNull()
  })

  it('keeps no more games than the best of', () => {
    expect(opened(detail({ kind: 'live' }, [[11, 5], [11, 7]], 1))).toEqual({
      gameNumber: '1',
      games: [[11, 5]],
      replaces: null,
    })
  })
})
