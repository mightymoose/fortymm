import { sha256, uuidBytes } from './bytes'
import { encode, type Cbor } from './cbor'
import type { Signer } from './envelope'

const COSE_SIGN1 = 18
const REGISTRATION_TAG = 'fortymm/key-registration/v1'

// The P-256 public key (x, y) as the COSE_Key {1: 2, -1: 1, -2: x, -3: y},
// 75 bytes, which the API stores.
export function coseKey(x: Uint8Array<ArrayBuffer>, y: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> {
  return encode(new Map<number, Cbor>([[1, 2], [-1, 1], [-2, x], [-3, y]]))
}

// The key's id, its RFC 9679 thumbprint.
export function keyId(coseKey: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  return sha256(coseKey)
}

// The proof that registers the signer's key to the account: a COSE_Sign1 of
// 160 bytes over {"fortymm/key-registration/v1": {1: account id}}.
export async function registrationProof(
  signer: Signer,
  accountId: string,
): Promise<Uint8Array<ArrayBuffer>> {
  const header = encode(new Map<number, Cbor>([[1, -7], [4, signer.kid]]))
  const payload = encode(new Map([[REGISTRATION_TAG, new Map([[1, uuidBytes(accountId)]])]]))
  const signature = await signer.sign(encode(['Signature1', header, new Uint8Array(), payload]))
  return encode({ tag: COSE_SIGN1, value: [header, new Map(), payload, signature] })
}
