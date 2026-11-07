import { coseKey, keyId } from '../signing/cose'
import type { Signer } from '../signing/envelope'

// Another phone's signing key, with the kid of its public key, so the
// approval page finds that its signatures hold.
export async function otherDevice(): Promise<Signer> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign'])
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey))
  return {
    kid: await keyId(coseKey(raw.slice(1, 33), raw.slice(33, 65))),
    sign: async (bytes) =>
      new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, bytes)),
  }
}
