import { describe, expect, it } from 'vitest'
import { hex } from '../signing/bytes'
import { signResult, type Signer } from '../signing/envelope'
import { encodePayload, resultHash, type MatchResult } from '../signing/result'
import { base64url } from '../signing/text'
import type { GamePoints } from './board'
import { demoMatch } from './demoMatches'
import { draftHash, fragmentResultSchema, readFragment, replacesOf, resultOf } from './fragment'

const SELF = { id: 'c4a8f6a2-1f0e-4a63-8d2e-7f5b9e1c3d42', name: 'excited egret 387' }
const match = demoMatch('demo', SELF)
const GAMES: GamePoints[] = [[11, 5], [7, 11]]

function result(overrides: Partial<MatchResult> = {}): MatchResult {
  return { ...resultOf(match, GAMES, null), ...overrides } as MatchResult
}

async function signer(): Promise<Signer> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign'])
  return {
    kid: new Uint8Array(32),
    sign: async (bytes) =>
      new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, bytes)),
  }
}

describe('fragmentResultSchema', () => {
  const schema = fragmentResultSchema(match)

  it('takes a completed result of legal games for the match', () => {
    expect(schema.safeParse(result()).success).toBe(true)
    expect(schema.safeParse(result({ games: [] })).success).toBe(true)
  })

  it.each<[string, Partial<MatchResult>]>([
    ['another match', { match: demoMatch('demo-spectator', SELF).uuid }],
    ['another best of', { bestOf: 7 }],
    ['a rated result', { rated: true }],
    ['an illegal game', { games: [[11, 10]] }],
    ['more games than the best of', { games: Array<GamePoints>(6).fill([11, 1]) }],
    ['a retirement', { ending: 'retired', retiredBy: 0 } as Partial<MatchResult>],
  ])('refuses %s', (_, overrides) => {
    expect(schema.safeParse(result(overrides)).success).toBe(false)
  })
})

describe('readFragment', () => {
  it('opens an empty fragment as no games', () => {
    expect(readFragment('', match)).toEqual({ kind: 'empty' })
  })

  it('opens a draft', () => {
    expect(readFragment(draftHash(match, GAMES, null, 1), match)).toEqual({ kind: 'draft', result: result() })
  })

  it('opens a signed result with its signers', async () => {
    const envelope = await signResult(await signer(), 1, result(), 1)
    expect(readFragment(base64url(envelope), match)).toMatchObject({ kind: 'signed', result: result(), signers: [1] })
  })

  it.each([
    ['bytes that aren’t base64url', '!!'],
    ['bytes that aren’t a result', base64url(new Uint8Array([1, 2, 3]))],
    ['an illegal game', base64url(encodePayload(1, result({ games: [[11, 10]] })))],
    ['another match', base64url(encodePayload(1, result({ match: demoMatch('demo-spectator', SELF).uuid })))],
  ])('is null for %s', (_, hash) => {
    expect(readFragment(hash, match)).toBeNull()
  })
})

describe('replacesOf', () => {
  it('names the signed result, or what the draft names', async () => {
    const envelope = await signResult(await signer(), 1, result(), 0)
    const signed = readFragment(base64url(envelope), match)!
    const hash = await replacesOf(signed)

    expect(hex(hash!)).toBe(hex(await resultHash(encodePayload(1, result()))))
    const draft = readFragment(draftHash(match, GAMES, hash, 2), match)!
    expect(hex((await replacesOf(draft))!)).toBe(hex(hash!))
    expect(await replacesOf({ kind: 'empty' })).toBeNull()
  })
})

describe('draftHash', () => {
  it('is empty for no games and nothing to correct', () => {
    expect(draftHash(match, [], null, 1)).toBe('')
    expect(draftHash(match, [], new Uint8Array(32), 1)).not.toBe('')
  })
})
