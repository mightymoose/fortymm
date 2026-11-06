import { describe, expect, it } from 'vitest'
import { eventText, score, type GameScore, type MatchEvent, type MatchRecord, type MatchStatus } from './match'

const final: MatchStatus = { kind: 'final', acceptedAt: '2026-11-02T18:39:00Z', approvedBy: [0, 1], overrideReason: null }

function record(fields: Partial<MatchRecord>): MatchRecord {
  return {
    id: '0193f1a2-0000-7000-8000-000000000001',
    bestOf: 5,
    rated: true,
    players: [
      { name: 'Wei Chen', you: false },
      { name: 'Meera Okafor', you: false },
    ],
    games: [],
    retiredBy: null,
    startedAt: '2026-11-02T18:00:00Z',
    status: final,
    ...fields,
  }
}

describe('score', () => {
  it('gives a final match to the side with more games', () => {
    expect(score(record({ games: [[8, 11], [11, 9], [5, 11]] })).winner).toBe(1)
  })

  it('gives a final match to the side that didn’t retire, even when behind', () => {
    expect(score(record({ games: [[8, 11], [11, 9], [2, 5]], retiredBy: 1 })).winner).toBe(0)
  })

  it('names no winner before the result counts', () => {
    const awaiting: MatchStatus = { kind: 'awaiting', signedBy: 0, signedAt: '2026-11-02T18:39:00Z' }
    expect(score(record({ games: [[11, 8]], retiredBy: 1, status: awaiting })).winner).toBeNull()
  })

  it('counts only finished games as won', () => {
    expect(score(record({ games: [[8, 11], [11, 9], [2, 5]], retiredBy: 1 })).won).toEqual([1, 1])
  })

  it('counts the last game of a live match as in play', () => {
    const { won, current } = score(record({ games: [[11, 8], [4, 2]], status: { kind: 'live' } }))
    expect(won).toEqual([1, 0])
    expect(current).toEqual([4, 2])
  })

  it('counts the last game of a live match as won once it reached a final score', () => {
    const { won, current } = score(record({ games: [[11, 4], [11, 9]], status: { kind: 'live' } }))
    expect(won).toEqual([2, 0])
    expect(current).toBeNull()
  })

  it('counts an unfinished last game of a live match as in play after a won game', () => {
    const { won, current } = score(record({ games: [[11, 4], [6, 4]], status: { kind: 'live' } }))
    expect(won).toEqual([1, 0])
    expect(current).toEqual([6, 4])
  })
})

describe('eventText', () => {
  const at = '2026-11-02T18:39:00Z'
  const created: MatchEvent = { at, kind: 'created', by: 'Wei Chen', side: null, games: [] }
  const signed = (side: 0 | 1, games: GameScore[]): MatchEvent => ({ at, kind: 'signed', by: null, side, games })
  const texts = (history: MatchEvent[]) => history.map((_, index) => eventText(history, index))
  const FIRST: GameScore[] = [[11, 5], [11, 7]]
  const OTHER: GameScore[] = [[11, 5], [7, 11], [11, 9]]

  it('says both sides signing the same scores together each signed the result', () => {
    expect(texts([created, signed(0, FIRST), signed(1, FIRST)])).toEqual([
      'Started the match',
      'Signed the result, 2–0',
      'Signed the result, 2–0',
    ])
  })

  it('says a side that counters the other side’s scores signed different scores', () => {
    expect(texts([created, signed(0, FIRST), signed(1, OTHER)])).toEqual([
      'Started the match',
      'Signed the result, 2–0',
      'Signed different scores, 2–1',
    ])
  })

  it('says a correction both sides signed together was different scores once', () => {
    expect(texts([created, signed(0, FIRST), signed(0, OTHER), signed(1, OTHER)]).slice(2)).toEqual([
      'Signed different scores, 2–1',
      'Signed the result, 2–1',
    ])
  })
})
