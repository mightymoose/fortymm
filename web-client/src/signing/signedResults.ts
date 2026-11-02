import { equalBytes, uuidBytes, uuidString, type Bytes } from './bytes'
import { CborError, decode, encode, Tagged, type Cbor, type CborMap } from './cbor'
import { fromBase45, fromBase64url, toBase45, toBase64url } from './textEncodings'

// The signed result format of api/signed-results/README.md: the payload, the
// COSE_Sign envelope, its QR text and link, and the key registration proof.
// The vectors in api/signed-results/vectors.json check every byte.

export type Side = 0 | 1
export type BestOf = 3 | 5 | 7
export type Ending = { kind: 'completed' } | { kind: 'retired'; by: Side }

export type MatchResult = {
  match: string
  bestOf: BestOf
  rated: boolean
  players: [string, string]
  games: [number, number][]
  ending: Ending
  // The hash of the result a correction replaces.
  replaces: Bytes | null
}

export type Payload = { issuedAt: number; result: MatchResult }

// A key that signs: its private half, which may be non-extractable, and its
// COSE_Key thumbprint.
export type SigningKey = { kid: Bytes; privateKey: CryptoKey }

export type CoseSignature = { protected: Bytes; signature: Bytes }

// The bytes of an envelope, kept as they came, with what they say.
export type Envelope = { payload: Bytes; signatures: CoseSignature[] }
export type DecodedEnvelope = Payload & {
  payload: Bytes
  signatures: (CoseSignature & { kid: Bytes; side: Side })[]
}

// The bytes aren't this format. The API's codec, and every client's, refuse
// the same inputs.
export class Malformed extends Error {}

const DOMAIN_TAG = 'fortymm/match-result/v1'
const REGISTRATION_TAG = 'fortymm/key-registration/v1'
const QR_PREFIX = 'FMR1:'
const LINK_PREFIX = 'https://fortymm.com/r#'
const ES256 = -7
const COSE_SIGN = 98
const COSE_SIGN1 = 18
const MAX_ISSUED_AT = 253402300799
const ECDSA = { name: 'ECDSA', hash: 'SHA-256' } as const
const EMPTY = new Uint8Array()

export function encodePayload({ issuedAt, result }: Payload): Bytes {
  const fields: [number, Cbor][] = [
    [1, uuidBytes(result.match)],
    [2, result.bestOf],
    [3, result.rated],
    [4, result.players.map(uuidBytes)],
    [5, result.games],
    [6, result.ending.kind === 'completed' ? 0 : 1],
  ]
  if (result.ending.kind === 'retired') fields.push([7, result.ending.by])
  if (result.replaces) fields.push([8, result.replaces])
  return encode(
    new Map<Cbor, Cbor>([
      [6, issuedAt],
      [DOMAIN_TAG, new Map(fields)],
    ]),
  )
}

export function decodePayload(bytes: Bytes): Payload {
  const claims = fields(cbor(bytes), [6n, DOMAIN_TAG], [])
  const issuedAt = uint(claims.get(6n))
  if (issuedAt > MAX_ISSUED_AT) throw new Malformed('iat is after 9999')
  const result = fields(claims.get(DOMAIN_TAG), [1n, 2n, 3n, 4n, 5n, 6n], [7n, 8n])

  const bestOf = uint(result.get(2n))
  if (bestOf !== 3 && bestOf !== 5 && bestOf !== 7) throw new Malformed('best_of')
  const rated = result.get(3n)
  if (typeof rated !== 'boolean') throw new Malformed('rated')
  const players = list(result.get(4n)).map((player) => byteString(player, 16))
  if (players.length !== 2 || equalBytes(players[0], players[1])) throw new Malformed('players')
  const games = list(result.get(5n)).map((game) => {
    const points = list(game).map(uint)
    if (points.length !== 2) throw new Malformed('game')
    return points as [number, number]
  })
  if (games.length > bestOf) throw new Malformed('games')
  const ending = result.get(6n)
  if (ending !== 0n && ending !== 1n) throw new Malformed('ending')
  const retired = ending === 1n
  if (retired !== result.has(7n)) throw new Malformed('retired_by')
  const replaces = result.get(8n)

  return {
    issuedAt,
    result: {
      match: uuidString(byteString(result.get(1n), 16)),
      bestOf,
      rated,
      players: [uuidString(players[0]), uuidString(players[1])],
      games,
      ending: retired ? { kind: 'retired', by: side(result.get(7n)) } : { kind: 'completed' },
      replaces: replaces === undefined ? null : byteString(replaces, 32),
    },
  }
}

// The result's identity, which a correction names in `replaces`.
export async function resultHash(payload: Bytes): Promise<Bytes> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', payload))
}

export function signerHeader(kid: Bytes, side: Side): Bytes {
  return encode(
    new Map<Cbor, Cbor>([
      [1, ES256],
      [4, kid],
      ['player', side],
    ]),
  )
}

export function toBeSigned(header: Bytes, payload: Bytes): Bytes {
  return encode(['Signature', EMPTY, header, EMPTY, payload])
}

// Approves `payload` for `side`. WebCrypto's ECDSA signature is already the
// raw r || s that COSE wants.
export async function sign(key: SigningKey, side: Side, payload: Bytes): Promise<CoseSignature> {
  const header = signerHeader(key.kid, side)
  return { protected: header, signature: await es256(key, toBeSigned(header, payload)) }
}

export function encodeEnvelope({ payload, signatures }: Envelope): Bytes {
  return encode(
    new Tagged(COSE_SIGN, [
      EMPTY,
      new Map(),
      payload,
      signatures.map((signature) => [signature.protected, new Map(), signature.signature]),
    ]),
  )
}

// Reads an envelope from its bytes, or throws Malformed. It doesn't verify
// the signatures, which needs the signers' keys.
export function decodeEnvelope(bytes: Bytes): DecodedEnvelope {
  const tagged = cbor(bytes)
  if (!(tagged instanceof Tagged) || tagged.tag !== COSE_SIGN) throw new Malformed('Not COSE_Sign')
  const [bodyHeader, bodyUnprotected, payload, signatures, ...rest] = list(tagged.item)
  if (rest.length > 0 || signatures === undefined) throw new Malformed('Envelope shape')
  if (byteString(bodyHeader).length > 0) throw new Malformed('Body protected header')
  empty(bodyUnprotected)
  const payloadBytes = byteString(payload)
  const signers = list(signatures).map((entry) => {
    const [header, unprotected, signature, ...more] = list(entry)
    if (more.length > 0 || signature === undefined) throw new Malformed('Signature shape')
    empty(unprotected)
    const headerBytes = byteString(header)
    const labels = fields(cbor(headerBytes), [1n, 4n, 'player'], [])
    if (labels.get(1n) !== BigInt(ES256)) throw new Malformed('alg')
    return {
      protected: headerBytes,
      signature: byteString(signature, 64),
      kid: byteString(labels.get(4n), 32),
      side: side(labels.get('player')),
    }
  })
  if (signers.length === 0) throw new Malformed('No signatures')
  return { payload: payloadBytes, ...decodePayload(payloadBytes), signatures: signers }
}

// The second signer's step. It keeps the received payload bytes as they are.
export function appendSignature(envelope: Bytes, signature: CoseSignature): Bytes {
  const { payload, signatures } = decodeEnvelope(envelope)
  return encodeEnvelope({ payload, signatures: [...signatures, signature] })
}

export function qrText(envelope: Bytes): string {
  return QR_PREFIX + toBase45(envelope)
}

export function link(envelope: Bytes): string {
  return LINK_PREFIX + toBase64url(envelope)
}

// The envelope bytes of a QR text or a link, or throws Malformed.
export function envelopeFromText(text: string): Bytes {
  const bytes = text.startsWith(QR_PREFIX)
    ? fromBase45(text.slice(QR_PREFIX.length))
    : text.startsWith(LINK_PREFIX)
      ? fromBase64url(text.slice(LINK_PREFIX.length))
      : null
  if (!bytes) throw new Malformed('Not a QR text or link of this format')
  return bytes
}

// The COSE_Key of a P-256 public key, from its 32-byte coordinates.
export function coseKey(x: Bytes, y: Bytes): Bytes {
  return encode(
    new Map<Cbor, Cbor>([
      [1, 2],
      [-1, 1],
      [-2, x],
      [-3, y],
    ]),
  )
}

// The RFC 9679 thumbprint of a COSE_Key, the kid a signature cites.
export async function keyId(key: Bytes): Promise<Bytes> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', key))
}

// Everything the proof signs, which the server builds itself.
export function registrationParts(kid: Bytes, accountId: string) {
  const header = encode(
    new Map<Cbor, Cbor>([
      [1, ES256],
      [4, kid],
    ]),
  )
  const payload = encode(new Map([[REGISTRATION_TAG, new Map([[1, uuidBytes(accountId)]])]]))
  return {
    protected: header,
    payload,
    toBeSigned: encode(['Signature1', header, EMPTY, payload]),
  }
}

// The COSE_Sign1 that proves the device holds `key` and means it for
// `accountId`.
export async function registrationProof(key: SigningKey, accountId: string): Promise<Bytes> {
  const parts = registrationParts(key.kid, accountId)
  const signature = await es256(key, parts.toBeSigned)
  return encode(new Tagged(COSE_SIGN1, [parts.protected, new Map(), parts.payload, signature]))
}

async function es256(key: SigningKey, signed: Bytes): Promise<Bytes> {
  return new Uint8Array(await crypto.subtle.sign(ECDSA, key.privateKey, signed))
}

function cbor(bytes: Bytes): Cbor {
  try {
    return decode(bytes)
  } catch (error) {
    if (error instanceof CborError) throw new Malformed(error.message)
    throw error
  }
}

// A map with exactly the `required` keys and any of the `optional` ones.
function fields(item: Cbor | undefined, required: Cbor[], optional: Cbor[]): CborMap {
  if (!(item instanceof Map)) throw new Malformed('Not a map')
  const allowed = [...required, ...optional]
  for (const key of item.keys()) {
    if (!allowed.includes(key)) throw new Malformed(`Unknown key ${String(key)}`)
  }
  for (const key of required) {
    if (!item.has(key)) throw new Malformed(`Missing key ${String(key)}`)
  }
  return item
}

function list(item: Cbor | undefined): Cbor[] {
  if (!Array.isArray(item)) throw new Malformed('Not an array')
  return item
}

function byteString(item: Cbor | undefined, length?: number): Bytes {
  if (!ArrayBuffer.isView(item)) throw new Malformed('Not a byte string')
  if (length !== undefined && item.length !== length) throw new Malformed('Wrong length')
  return item
}

// A uint. Points or a time past 2^53 lose precision as a number, but no
// legal result comes near that, and the format still accepts them.
function uint(item: Cbor | undefined): number {
  if (typeof item !== 'bigint' || item < 0n) throw new Malformed('Not a uint')
  return Number(item)
}

function side(item: Cbor | undefined): Side {
  if (item !== 0n && item !== 1n) throw new Malformed('Not a side')
  return Number(item) as Side
}

function empty(item: Cbor | undefined): void {
  if (!(item instanceof Map) || item.size > 0) throw new Malformed('Header not empty')
}
