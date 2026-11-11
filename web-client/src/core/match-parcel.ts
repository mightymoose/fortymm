import type { Core } from 'fortymm-core/fortymm-core.mjs'

// Making a signed `match` parcel in the browser, as a device would (design
// sections 4 and 4.4, the web row). The core builds the body and assembles
// the record; the core never signs, so WebCrypto signs. Nothing here is
// stored: the key lives as long as whoever holds the Signer.

export type Signer = {
  // Created non-extractable: the private key cannot leave WebCrypto.
  privateKey: CryptoKey
  // The 33-byte form a record stores.
  publicKey: Uint8Array
}

export type MatchDraft = {
  environment: number
  sides: [Uint8Array[], Uint8Array[]]
  terms: Uint8Array
}

const ecdsa = { name: 'ECDSA', namedCurve: 'P-256' } as const

// A new P-256 key. The private key is non-extractable.
export async function createSigner(core: Core): Promise<Signer> {
  const pair = await crypto.subtle.generateKey(ecdsa, false, ['sign'])
  // WebCrypto exports the public key uncompressed; the core converts it.
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey))
  return { privateKey: pair.privateKey, publicKey: core.publicKeyFromRaw(raw) }
}

// The text of a parcel holding one new `match` record, signed by `signer`.
// Each call makes a new record: the random value is new every time.
export async function makeMatchParcel(
  core: Core,
  signer: Signer,
  { environment, sides, terms }: MatchDraft,
): Promise<string> {
  const random = crypto.getRandomValues(new Uint8Array(8))
  const body = core.matchBody(environment, signer.publicKey, random, sides, terms)
  const raw = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    signer.privateKey,
    body as Uint8Array<ArrayBuffer>,
  )
  const record = core.recordFromParts(body, core.signatureFromRaw(new Uint8Array(raw)))
  return core.text(core.build(environment, [record]))
}

// Bytes from lowercase or uppercase hex with an even number of digits, or
// null.
export function fromHex(text: string): Uint8Array | null {
  const clean = text.trim()
  if (!/^([0-9a-fA-F]{2})*$/.test(clean)) return null
  return Uint8Array.from(clean.match(/../g) ?? [], (pair) => parseInt(pair, 16))
}

// Player ids, one per line (blank lines ignored): each 32 bytes of hex. Null
// if any line is not, or there are none.
export function playerIds(text: string): Uint8Array[] | null {
  const ids = text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map(fromHex)
  if (ids.length === 0 || ids.some((id) => id === null || id.length !== 32)) {
    return null
  }
  return ids as Uint8Array[]
}
