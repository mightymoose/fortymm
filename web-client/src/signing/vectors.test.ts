import { describe, expect, it } from 'vitest'
import vectors from '../../../api/signed-results/vectors.json'
import { fromHex } from './bytes'
import { Malformed } from './cbor'
import { coseKey, keyId, registrationProof } from './cose'
import {
  appendSignature,
  assembleEnvelope,
  decodeEnvelope,
  sigStructure,
  signResult,
  signerHeader,
  type Signer,
} from './envelope'
import { decodePayload, encodePayload, resultHash, type MatchResult } from './result'
import { base64url, envelopeFromText, link, qrText } from './text'

type VectorKey = (typeof vectors.keys)['ann']
type VectorResult = (typeof vectors.valid)[number]['result']

const ECDSA = { name: 'ECDSA', hash: 'SHA-256' }
const P256 = { name: 'ECDSA', namedCurve: 'P-256' }
const keys: Record<string, VectorKey> = vectors.keys

function matchResult(result: VectorResult): MatchResult {
  const base = {
    match: result.match,
    bestOf: result.best_of as 3 | 5 | 7,
    rated: result.rated,
    players: result.players as [string, string],
    games: result.games as [number, number][],
    replaces: result.replaces === null ? null : fromHex(result.replaces),
  }
  return result.ending === 'completed'
    ? { ...base, ending: 'completed' }
    : { ...base, ending: 'retired', retiredBy: result.retired_by as 0 | 1 }
}

function publicKey(key: VectorKey): Promise<CryptoKey> {
  const jwk = { kty: 'EC', crv: 'P-256', x: b64(key.x), y: b64(key.y) }
  return crypto.subtle.importKey('jwk', jwk, P256, false, ['verify'])
}

// The key from `d` through the platform's own signer.
async function platformSigner(key: VectorKey): Promise<Signer> {
  const jwk = { kty: 'EC', crv: 'P-256', x: b64(key.x), y: b64(key.y), d: b64(key.d) }
  const privateKey = await crypto.subtle.importKey('jwk', jwk, P256, false, ['sign'])
  return {
    kid: fromHex(key.kid),
    sign: async (data) => new Uint8Array(await crypto.subtle.sign(ECDSA, privateKey, data)),
  }
}

// A signer that answers with the vector's signature, after checking that it
// was asked to sign the vector's bytes.
function vectorSigner(kid: string, toBeSigned: string, signature: string): Signer {
  return {
    kid: fromHex(kid),
    sign: async (data) => {
      expect(data).toEqual(fromHex(toBeSigned))
      return fromHex(signature)
    },
  }
}

function verifies(
  key: VectorKey,
  signature: Uint8Array<ArrayBuffer>,
  data: Uint8Array<ArrayBuffer>,
): Promise<boolean> {
  return publicKey(key).then((found) => crypto.subtle.verify(ECDSA, found, signature, data))
}

const b64 = (text: string) => base64url(fromHex(text))

// PKCS#8 of a P-256 key with no public key, so importing it derives (x, y).
const PKCS8_PREFIX = '3041020100301306072a8648ce3d020106082a8648ce3d030107042730250201010420'

describe('the signed result vectors', () => {
  it('are format v1', () => {
    expect(vectors.format).toBe('fortymm/match-result/v1')
  })

  describe.each(Object.entries(keys))('key %s', (_, key) => {
    it('K1. derives (x, y) from d', async () => {
      const imported = await crypto.subtle.importKey(
        'pkcs8',
        fromHex(PKCS8_PREFIX + key.d),
        P256,
        true,
        ['sign'],
      )
      const jwk = await crypto.subtle.exportKey('jwk', imported)
      expect([jwk.x, jwk.y]).toEqual([b64(key.x), b64(key.y)])
    })

    it('K2 and K3. encodes (x, y) as cose_key, whose SHA-256 is kid', async () => {
      const encoded = coseKey(fromHex(key.x), fromHex(key.y))
      expect(encoded).toEqual(fromHex(key.cose_key))
      expect(await keyId(encoded)).toEqual(fromHex(key.kid))
    })
  })

  describe.each(vectors.valid.map((vector) => [vector.name, vector] as const))(
    'valid %s',
    (_, vector) => {
      const payload = fromHex(vector.payload)
      const envelope = fromHex(vector.envelope)
      const result = matchResult(vector.result)

      it('V1. encodes the payload byte for byte', () => {
        expect(encodePayload(vector.issued_at, result)).toEqual(payload)
      })

      it('V2. decodes the payload back, and hashes it', async () => {
        expect(decodePayload(payload)).toEqual({ issuedAt: vector.issued_at, result })
        expect(await resultHash(payload)).toEqual(fromHex(vector.hash))
      })

      it('V3. builds each signer header and Sig_structure', () => {
        for (const signature of vector.signatures) {
          const header = signerHeader(fromHex(signature.kid), signature.side as 0 | 1)
          expect(header).toEqual(fromHex(signature.protected))
          expect(sigStructure(header, payload)).toEqual(fromHex(signature.to_be_signed))
        }
      })

      it('V4. verifies each signature, and signs with the platform signer', async () => {
        for (const signature of vector.signatures) {
          const key = keys[signature.key]
          const toBeSigned = fromHex(signature.to_be_signed)
          expect(await verifies(key, fromHex(signature.signature), toBeSigned)).toBe(true)
          const signed = await (await platformSigner(key)).sign(toBeSigned)
          expect(signed).toHaveLength(64)
          expect(await verifies(key, signed, toBeSigned)).toBe(true)
        }
      })

      it('V5. assembles and decodes the envelope, and the last signer appends to it', async () => {
        const signatures = vector.signatures.map((signature) => ({
          protected: fromHex(signature.protected),
          signature: fromHex(signature.signature),
        }))
        expect(assembleEnvelope(payload, signatures)).toEqual(envelope)
        expect(decodeEnvelope(envelope)).toEqual({
          payload,
          signatures: vector.signatures.map((signature, i) => ({
            ...signatures[i],
            kid: fromHex(signature.kid),
            side: signature.side,
          })),
        })

        const [first] = vector.signatures
        const signed = await signResult(
          vectorSigner(first.kid, first.to_be_signed, first.signature),
          vector.issued_at,
          result,
          first.side as 0 | 1,
        )
        expect(signed).toEqual(assembleEnvelope(payload, signatures.slice(0, 1)))

        if (signatures.length < 2) return
        const last = vector.signatures.at(-1)!
        const appended = await appendSignature(
          vectorSigner(last.kid, last.to_be_signed, last.signature),
          assembleEnvelope(payload, signatures.slice(0, -1)),
          last.side as 0 | 1,
        )
        expect(appended).toEqual(envelope)
      })

      it('V6. writes the QR text and the link, and reads both back', () => {
        expect(qrText(envelope)).toBe(vector.qr)
        expect(link(envelope)).toBe(vector.link)
        expect(envelopeFromText(vector.qr)).toEqual(envelope)
        expect(envelopeFromText(vector.link)).toEqual(envelope)
      })

      it('V7. uses only QR alphanumeric characters, within version 16 at level M', () => {
        expect(vector.qr).toMatch(/^[0-9A-Z $%*+\-./:]*$/)
        if (vector.signatures.length <= 2) expect(vector.qr.length).toBeLessThanOrEqual(656)
      })
    },
  )

  describe.each(vectors.registrations.map((vector) => [vector.name, vector] as const))(
    'registration %s',
    (_, vector) => {
      const key = keys[vector.key]
      const proof = fromHex(vector.proof)
      const toBeSigned = fromHex(vector.to_be_signed)

      it('R1. builds the proof around its Sig_structure', async () => {
        const signer = vectorSigner(key.kid, vector.to_be_signed, vector.signature)
        expect(await registrationProof(signer, vector.account)).toEqual(proof)
      })

      it('R2. verifies its signature, and signs a proof with the platform signer', async () => {
        expect(await verifies(key, fromHex(vector.signature), toBeSigned)).toBe(true)
        const signed = await registrationProof(await platformSigner(key), vector.account)
        expect(signed).toHaveLength(160)
        expect(signed.subarray(0, 96)).toEqual(proof.subarray(0, 96))
        expect(await verifies(key, signed.subarray(96), toBeSigned)).toBe(true)
      })
    },
  )

  describe.each(vectors.invalid.map((vector) => [vector.name, vector] as const))(
    'invalid %s',
    (_, vector) => {
      const read = () =>
        decodeEnvelope(
          vector.text === undefined ? fromHex(vector.envelope!) : envelopeFromText(vector.text),
        )

      it(`I2. ${vector.error === 'malformed' ? 'is refused' : 'decodes'} at decode`, () => {
        if (vector.error === 'malformed') expect(read).toThrow(Malformed)
        else expect(read).not.toThrow()
      })
    },
  )
})
