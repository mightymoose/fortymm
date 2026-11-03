import { describe, expect, it } from 'vitest'
import { encodePayload } from '../signing/result'
import { demoMatch } from './demoMatches'
import { signedResultOf } from './signedResult'
import type { Submitted } from './scratchpad'

const self = { id: 'c4a8f6a2-1f0e-4a63-8d2e-7f5b9e1c3d42', name: 'excited egret 387' }
const match = demoMatch('demo', self)
const opponent = match.players[1].id

function submitted(by: string): Submitted {
  return {
    phase: 'submitted',
    by,
    games: [[11, 7], [9, 11], [11, 4], [11, 8]],
    submittedAt: '2026-11-03T12:34:56.789Z',
  }
}

describe('signedResultOf', () => {
  it('names the match, its players in order and the approved games', () => {
    const { issuedAt, result, side } = signedResultOf(match, submitted(self.id))
    expect(issuedAt).toBe(Date.UTC(2026, 10, 3, 12, 34, 56) / 1000)
    expect(result).toEqual({
      match: match.uuid,
      bestOf: 5,
      rated: false,
      players: [self.id, opponent],
      games: [[11, 7], [9, 11], [11, 4], [11, 8]],
      ending: 'completed',
      replaces: null,
    })
    expect(side).toBe(0)
  })

  it('signs for the submitter’s side', () => {
    expect(signedResultOf(match, submitted(opponent)).side).toBe(1)
  })

  it('makes a payload the codec accepts', () => {
    const { issuedAt, result } = signedResultOf(match, submitted(self.id))
    expect(() => encodePayload(issuedAt, result)).not.toThrow()
  })

  it('refuses a submitter who doesn’t play the match', () => {
    expect(() => signedResultOf(match, submitted(match.uuid))).toThrow(RangeError)
  })
})
