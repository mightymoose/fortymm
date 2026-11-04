import { uuidText } from '../signing/bytes'

// A UUIDv7 (RFC 9562): 48 bits of Unix time in milliseconds, the version,
// then random bits. Ids made later sort later, so the API's indexes stay
// in order.
export function uuidv7(now: number = Date.now()): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  let time = now
  for (let at = 5; at >= 0; at--) {
    bytes[at] = time % 256
    time = Math.floor(time / 256)
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x70
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  return uuidText(bytes)
}
