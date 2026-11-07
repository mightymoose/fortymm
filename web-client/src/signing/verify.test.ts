import { describe, expect, it } from 'vitest'
import vectors from '../../../api/signed-results/vectors.json'
import { fromHex } from './bytes'
import { signResult } from './envelope'
import type { MatchResult } from './result'
import { otherDevice as browserSigner } from '../test/otherDevice'
import { signaturesHold } from './verify'

const byName = (name: string) => vectors.invalid.find((vector) => vector.name === name)!

const result = {
  match: '3b7e9f2a-6c41-4d8e-b5a0-1f9c2d7e4a63',
  bestOf: 3,
  rated: true,
  players: ['6f1d2c43-8b5e-4a0f-9c71-2e4b8d0a5f13', '0c9e7b21-3d4a-4f68-a1b5-7e2f9c8d6a40'],
  games: [[11, 5], [11, 9]],
  ending: 'completed',
  replaces: null,
} as MatchResult

describe('signaturesHold', () => {
  it.each(vectors.valid.map((vector) => [vector.name, vector.envelope]))('holds for the valid vector %s', async (_, envelope) => {
    expect(await signaturesHold(fromHex(envelope))).toBe(true)
  })

  it.each(['tampered-payload', 'unknown-kid-and-tampered-payload'])(
    'doesn’t hold for the vector %s',
    async (name) => {
      expect(await signaturesHold(fromHex(byName(name).envelope!))).toBe(false)
    },
  )

  // Only FortyMM knows which keys are registered, so a genuine signature by
  // a key it doesn't know holds here.
  it('holds for the vector unknown-kid', async () => {
    expect(await signaturesHold(fromHex(byName('unknown-kid').envelope!))).toBe(true)
  })

  it('holds for a browser’s signature, many times over, whichever half its s is in', async () => {
    const signer = await browserSigner()
    for (let i = 0; i < 20; i++) {
      expect(await signaturesHold(await signResult(signer, 1_793_700_000 + i, result, 0))).toBe(true)
    }
  })

  it('doesn’t hold once a score changes', async () => {
    const envelope = await signResult(await browserSigner(), 1_793_700_000, result, 0)
    // Game 2's 11–9 is 0x82 0x0b 0x09. 11–7 is a legal score too.
    const at = indexOf(envelope, [0x82, 0x0b, 0x09]) + 2
    envelope[at] = 0x07

    expect(await signaturesHold(envelope)).toBe(false)
  })

  it('doesn’t hold once a signature’s byte changes', async () => {
    const envelope = await signResult(await browserSigner(), 1_793_700_000, result, 0)
    envelope[envelope.length - 1] ^= 0x01

    expect(await signaturesHold(envelope)).toBe(false)
  })

  it('doesn’t hold for a signature by another key than its kid names', async () => {
    const signer = await browserSigner()
    const other = await browserSigner()
    const envelope = await signResult({ kid: signer.kid, sign: other.sign }, 1_793_700_000, result, 0)

    expect(await signaturesHold(envelope)).toBe(false)
  })
})

function indexOf(bytes: Uint8Array, needle: number[]): number {
  return bytes.findIndex((_, at) => needle.every((byte, offset) => bytes[at + offset] === byte))
}
