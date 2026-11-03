import {
  array,
  bstr,
  decode,
  encode,
  exactKeys,
  Malformed,
  side,
  type Cbor,
  type Side,
} from './cbor'
import { decodePayload, encodePayload, type MatchResult } from './result'

// One signer's COSE_Signature: its protected header and the raw r || s.
export type CoseSignature = {
  protected: Uint8Array<ArrayBuffer>
  signature: Uint8Array<ArrayBuffer>
}

// A device key that signs. `kid` is its COSE_Key thumbprint, and `sign`
// returns an ES256 signature of `toBeSigned` as the 64 bytes r || s.
export type Signer = {
  kid: Uint8Array<ArrayBuffer>
  sign(toBeSigned: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>>
}

const COSE_SIGN = 98
const ALG = 1
const KID = 4
const PLAYER = 'player'
const ES256 = -7
const SIGNATURE_BYTES = 64
const EMPTY = new Uint8Array()

// {1: -7, 4: kid, "player": side}, in deterministic CBOR.
export function signerHeader(kid: Uint8Array<ArrayBuffer>, side: Side): Uint8Array<ArrayBuffer> {
  return encode(new Map<number | string, Cbor>([[ALG, ES256], [KID, kid], [PLAYER, side]]))
}

// What a signer signs (RFC 9052 section 4.4): the empty body header and no
// external data around the signer's header and the payload.
export function sigStructure(
  protectedHeader: Uint8Array<ArrayBuffer>,
  payload: Uint8Array<ArrayBuffer>,
): Uint8Array<ArrayBuffer> {
  return encode(['Signature', EMPTY, protectedHeader, EMPTY, payload])
}

export function assembleEnvelope(
  payload: Uint8Array<ArrayBuffer>,
  signatures: CoseSignature[],
): Uint8Array<ArrayBuffer> {
  return encode({
    tag: COSE_SIGN,
    value: [
      EMPTY,
      new Map(),
      payload,
      signatures.map((s) => [s.protected, new Map(), s.signature]),
    ],
  })
}

// The envelope's payload bytes and its signatures, each with the kid and the
// side its header names. Throws Malformed for anything that isn't this
// format, decided from the bytes alone. It checks no signature.
export function decodeEnvelope(bytes: Uint8Array<ArrayBuffer>): {
  payload: Uint8Array<ArrayBuffer>
  signatures: (CoseSignature & { kid: Uint8Array<ArrayBuffer>; side: Side })[]
} {
  const envelope = decode(bytes)
  if (typeof envelope !== 'object' || !('tag' in envelope) || envelope.tag !== COSE_SIGN) {
    throw new Malformed('not a COSE_Sign (tag 98)')
  }
  const [bodyHeader, unprotected, payload, signatures] = array(envelope.value, 4)
  bstr(bodyHeader, 0)
  exactKeys(unprotected, [])
  if (!ArrayBuffer.isView(payload)) throw new Malformed('the payload isn\'t a byte string')
  decodePayload(payload)
  const decoded = array(signatures).map((item) => {
    const [protectedHeader, signerUnprotected, signature] = array(item, 3)
    if (!ArrayBuffer.isView(protectedHeader)) {
      throw new Malformed('a signer header isn\'t a byte string')
    }
    exactKeys(signerUnprotected, [])
    const header = exactKeys(decode(protectedHeader), [ALG, KID, PLAYER])
    if (header.get(ALG) !== ES256) throw new Malformed('a signer\'s alg isn\'t ES256')
    return {
      protected: protectedHeader,
      signature: bstr(signature, SIGNATURE_BYTES),
      kid: bstr(header.get(KID), 32),
      side: side(header.get(PLAYER)),
    }
  })
  if (decoded.length === 0) throw new Malformed('no signatures')
  return { payload, signatures: decoded }
}

// A new envelope with one signature, in which `signer` approves the result
// for the player on `side`.
export async function signResult(
  signer: Signer,
  issuedAt: number,
  result: MatchResult,
  side: Side,
): Promise<Uint8Array<ArrayBuffer>> {
  const payload = encodePayload(issuedAt, result)
  return assembleEnvelope(payload, [await cosign(signer, payload, side)])
}

// What the second signer does. It signs the received payload bytes and
// never encodes the payload again, because a re-encoded payload is another
// result, or breaks the first signature.
export async function appendSignature(
  signer: Signer,
  envelope: Uint8Array<ArrayBuffer>,
  side: Side,
): Promise<Uint8Array<ArrayBuffer>> {
  const { payload, signatures } = decodeEnvelope(envelope)
  return assembleEnvelope(payload, [...signatures, await cosign(signer, payload, side)])
}

async function cosign(
  signer: Signer,
  payload: Uint8Array<ArrayBuffer>,
  side: Side,
): Promise<CoseSignature> {
  const header = signerHeader(signer.kid, side)
  return { protected: header, signature: await signer.sign(sigStructure(header, payload)) }
}
