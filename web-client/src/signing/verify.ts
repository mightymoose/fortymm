import { p256 } from '@noble/curves/nist.js'
import { sha256 } from './bytes'
import { coseKey, keyId } from './cose'
import { decodeEnvelope, sigStructure, type CoseSignature } from './envelope'

// Whether every signature in `envelope` was made by the key its kid names,
// over the envelope's payload. A signer header holds only the kid, a hash
// of the key, and the device knows no other account's key, so each key is
// recovered from its signature and hashed. It needs no network. Throws
// Malformed for an envelope that isn't this format.
export async function signaturesHold(envelope: Uint8Array<ArrayBuffer>): Promise<boolean> {
  const { payload, signatures } = decodeEnvelope(envelope)
  for (const signature of signatures) {
    if (!(await holds(signature, sigStructure(signature.protected, payload)))) return false
  }
  return true
}

async function holds(
  { signature, kid }: CoseSignature & { kid: Uint8Array<ArrayBuffer> },
  message: Uint8Array<ArrayBuffer>,
): Promise<boolean> {
  let parsed
  try {
    parsed = p256.Signature.fromBytes(signature, 'compact')
  } catch {
    return false
  }
  const digest = await sha256(message)
  const wanted = kid.join()
  for (const bit of [0, 1, 2, 3]) {
    let key: Uint8Array
    try {
      key = parsed.addRecoveryBit(bit).recoverPublicKey(digest).toBytes(false)
    } catch {
      continue
    }
    const id = await keyId(coseKey(new Uint8Array(key.slice(1, 33)), new Uint8Array(key.slice(33, 65))))
    // WebCrypto signs with either half of s, so a high s is valid here.
    if (id.join() === wanted) return p256.verify(signature, message, key, { lowS: false })
  }
  return false
}
