import { describe, expect, test } from 'vitest'
import vectors from '../../../api/signed-results/vectors.json'
import { fromHex, toHex, type Bytes } from './bytes'
import {
  appendSignature,
  coseKey,
  decodeEnvelope,
  decodePayload,
  encodeEnvelope,
  encodePayload,
  envelopeFromText,
  keyId,
  link,
  Malformed,
  qrText,
  registrationParts,
  registrationProof,
  resultHash,
  sign,
  signerHeader,
  toBeSigned,
  type MatchResult,
  type Side,
} from './signedResults'

// The shared test vectors of api/signed-results/vectors.json, through the
// signer checks of api/signed-results/README.md ("Checks a client's suite
// runs"). The web client signs and decodes. It doesn't verify, so the
// verifier checks V8 and I1 belong to the API's suite.

type VectorKey = (typeof vectors.keys)['ann']
type VectorResult = (typeof vectors.valid)[number]['result']

const ECDSA = { name: 'ECDSA', namedCurve: 'P-256' } as const
const ES256 = { name: 'ECDSA', hash: 'SHA-256' } as const
// PKCS#8 of a P-256 private key with no public key, up to the scalar.
// WebCrypto works out the public point from it, which is check K1.
const PKCS8_PREFIX = fromHex('308141020100301306072a8648ce3d020106082a8648ce3d030107042730250201010420')

function keyOf(name: string): VectorKey {
  return vectors.keys[name as keyof typeof vectors.keys]
}

async function privateKeyFrom(key: VectorKey, extractable = false): Promise<CryptoKey> {
  const pkcs8 = new Uint8Array([...PKCS8_PREFIX, ...fromHex(key.d)])
  return crypto.subtle.importKey('pkcs8', pkcs8, ECDSA, extractable, ['sign'])
}

async function publicKeyOf(key: VectorKey): Promise<CryptoKey> {
  const raw = new Uint8Array([4, ...fromHex(key.x), ...fromHex(key.y)])
  return crypto.subtle.importKey('raw', raw, ECDSA, true, ['verify'])
}

function verifies(key: CryptoKey, signature: Bytes, signed: Bytes): Promise<boolean> {
  return crypto.subtle.verify(ES256, key, signature, signed)
}

function resultOf(result: VectorResult): MatchResult {
  return {
    match: result.match,
    bestOf: result.best_of as MatchResult['bestOf'],
    rated: result.rated,
    players: [result.players[0], result.players[1]],
    games: result.games.map(([a, b]) => [a, b]),
    ending:
      result.ending === 'retired'
        ? { kind: 'retired', by: result.retired_by as Side }
        : { kind: 'completed' },
    replaces: result.replaces === null ? null : fromHex(result.replaces),
  }
}

test('the vectors are of this format', () => {
  expect(vectors.format).toBe('fortymm/match-result/v1')
})

describe.each(Object.entries(vectors.keys))('key %s', (_name, key) => {
  test('K1. its private scalar gives its public point', async () => {
    const jwk = await crypto.subtle.exportKey('jwk', await privateKeyFrom(key, true))
    expect(toHex(base64url(jwk.x!))).toBe(key.x)
    expect(toHex(base64url(jwk.y!))).toBe(key.y)
  })

  test('K2. its COSE_Key encodes as cose_key', () => {
    expect(toHex(coseKey(fromHex(key.x), fromHex(key.y)))).toBe(key.cose_key)
  })

  test('K3. its thumbprint is kid', async () => {
    expect(toHex(await keyId(fromHex(key.cose_key)))).toBe(key.kid)
  })
})

describe.each(vectors.valid.map((vector) => [vector.name, vector] as const))(
  'valid vector %s',
  (_name, vector) => {
    const payload = fromHex(vector.payload)
    const result = resultOf(vector.result)

    test('V1. encoding its result gives its payload', () => {
      expect(toHex(encodePayload({ issuedAt: vector.issued_at, result }))).toBe(vector.payload)
    })

    test('V2. decoding its payload gives its result and hash', async () => {
      expect(decodePayload(payload)).toEqual({ issuedAt: vector.issued_at, result })
      expect(toHex(await resultHash(payload))).toBe(vector.hash)
    })

    test('V3. each signer header and Sig_structure match', () => {
      for (const signature of vector.signatures) {
        const header = signerHeader(fromHex(signature.kid), signature.side as Side)
        expect(toHex(header)).toBe(signature.protected)
        expect(toHex(toBeSigned(header, payload))).toBe(signature.to_be_signed)
      }
    })

    test('V4. each signature verifies, and so does a signature made here', async () => {
      for (const signature of vector.signatures) {
        const key = keyOf(signature.key)
        const signed = fromHex(signature.to_be_signed)
        const publicKey = await publicKeyOf(key)
        expect(await verifies(publicKey, fromHex(signature.signature), signed)).toBe(true)

        const made = await sign(
          { kid: fromHex(key.kid), privateKey: await privateKeyFrom(key) },
          signature.side as Side,
          payload,
        )
        expect(toHex(made.protected)).toBe(signature.protected)
        expect(await verifies(publicKey, made.signature, signed)).toBe(true)
      }
    })

    test('V5. its signatures assemble into its envelope, appended one at a time', () => {
      const signatures = vector.signatures.map((signature) => ({
        protected: fromHex(signature.protected),
        signature: fromHex(signature.signature),
      }))
      expect(toHex(encodeEnvelope({ payload, signatures }))).toBe(vector.envelope)
      if (signatures.length < 2) return
      const others = encodeEnvelope({ payload, signatures: signatures.slice(0, -1) })
      expect(toHex(appendSignature(others, signatures.at(-1)!))).toBe(vector.envelope)
    })

    test('V6. its QR text and link match, and read back to its envelope', () => {
      const envelope = fromHex(vector.envelope)
      expect(qrText(envelope)).toBe(vector.qr)
      expect(link(envelope)).toBe(vector.link)
      expect(toHex(envelopeFromText(vector.qr))).toBe(vector.envelope)
      expect(toHex(envelopeFromText(vector.link))).toBe(vector.envelope)
    })

    test('V7. its QR text is alphanumeric and fits version 16 at level M', () => {
      expect(vector.qr).toMatch(/^[0-9A-Z $%*+\-./:]+$/)
      if (vector.signatures.length <= 2) expect(vector.qr.length).toBeLessThanOrEqual(656)
    })

    test('decoding its envelope gives its payload and signatures', () => {
      const decoded = decodeEnvelope(fromHex(vector.envelope))
      expect(toHex(decoded.payload)).toBe(vector.payload)
      expect(decoded.result).toEqual(result)
      expect(
        decoded.signatures.map((signature) => ({
          kid: toHex(signature.kid),
          side: signature.side,
          signature: toHex(signature.signature),
        })),
      ).toEqual(
        vector.signatures.map((signature) => ({
          kid: signature.kid,
          side: signature.side,
          signature: signature.signature,
        })),
      )
    })
  },
)

describe.each(vectors.invalid.map((vector) => [vector.name, vector] as const))(
  'invalid vector %s',
  (_name, vector) => {
    const read = () =>
      'text' in vector && vector.text !== undefined
        ? decodeEnvelope(envelopeFromText(vector.text))
        : decodeEnvelope(fromHex(vector.envelope!))

    test(`I2. decoding it ${vector.error === 'malformed' ? 'refuses it' : 'accepts it'}`, () => {
      if (vector.error === 'malformed') expect(read).toThrow(Malformed)
      else expect(read).not.toThrow()
    })
  },
)

describe.each(vectors.registrations.map((vector) => [vector.name, vector] as const))(
  'registration %s',
  (_name, vector) => {
    const key = keyOf(vector.key)

    test('R1. its header, payload and Sig_structure match', () => {
      const parts = registrationParts(fromHex(key.kid), vector.account)
      expect(toHex(parts.protected)).toBe(vector.protected)
      expect(toHex(parts.payload)).toBe(vector.payload)
      expect(toHex(parts.toBeSigned)).toBe(vector.to_be_signed)
    })

    test('R2. its signature verifies, and a proof made here differs only in its signature', async () => {
      const publicKey = await publicKeyOf(key)
      const signed = fromHex(vector.to_be_signed)
      expect(await verifies(publicKey, fromHex(vector.signature), signed)).toBe(true)

      const proof = await registrationProof(
        { kid: fromHex(key.kid), privateKey: await privateKeyFrom(key) },
        vector.account,
      )
      expect(proof).toHaveLength(160)
      expect(toHex(proof.slice(0, 96))).toBe(vector.proof.slice(0, 192))
      expect(await verifies(publicKey, proof.slice(96), signed)).toBe(true)
    })
  },
)

function base64url(text: string): Bytes {
  const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/'))
  return Uint8Array.from(binary, (char) => char.charCodeAt(0))
}
