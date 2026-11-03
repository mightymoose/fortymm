import { Malformed } from './cbor'

export const QR_PREFIX = 'FMR1:'
export const LINK_PREFIX = 'https://fortymm.com/r#'

// The QR text: every character is in QR's alphanumeric set.
export function qrText(envelope: Uint8Array<ArrayBuffer>): string {
  return QR_PREFIX + base45(envelope)
}

// The link. Its fragment never reaches a server log or a link preview.
export function link(envelope: Uint8Array<ArrayBuffer>): string {
  return LINK_PREFIX + base64url(envelope)
}

// The envelope bytes of a QR text or a link, still to be decoded. Throws
// Malformed for any other prefix or an encoding that isn't strict.
export function envelopeFromText(text: string): Uint8Array<ArrayBuffer> {
  if (text.startsWith(QR_PREFIX)) return fromBase45(text.slice(QR_PREFIX.length))
  if (text.startsWith(LINK_PREFIX)) return fromBase64url(text.slice(LINK_PREFIX.length))
  throw new Malformed('neither a QR text nor a link')
}

const BASE45 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:'

// RFC 9285: each two bytes become three characters, low digit first, and a
// last odd byte becomes two.
function base45(bytes: Uint8Array<ArrayBuffer>): string {
  let text = ''
  for (let i = 0; i < bytes.length; i += 2) {
    const pair = bytes.length - i > 1
    let n = pair ? bytes[i] * 256 + bytes[i + 1] : bytes[i]
    for (let digits = pair ? 3 : 2; digits > 0; digits--) {
      text += BASE45[n % 45]
      n = Math.floor(n / 45)
    }
  }
  return text
}

function fromBase45(text: string): Uint8Array<ArrayBuffer> {
  if (text.length % 3 === 1) throw new Malformed('a Base45 text can\'t be 1 mod 3 long')
  const bytes: number[] = []
  for (let i = 0; i < text.length; i += 3) {
    const group = text.slice(i, i + 3)
    let n = 0
    for (let k = group.length - 1; k >= 0; k--) {
      const digit = BASE45.indexOf(group[k])
      if (digit === -1) throw new Malformed('a character isn\'t in the Base45 alphabet')
      n = n * 45 + digit
    }
    if (group.length === 3) {
      if (n > 0xffff) throw new Malformed('a Base45 group is worth more than two bytes')
      bytes.push(n >> 8, n & 0xff)
    } else {
      if (n > 0xff) throw new Malformed('a Base45 group is worth more than one byte')
      bytes.push(n)
    }
  }
  return Uint8Array.from(bytes)
}

export function base64url(bytes: Uint8Array<ArrayBuffer>): string {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '')
}

// Strict unpadded base64url: the bytes must encode back to the same text,
// which refuses padding, the standard alphabet and nonzero spare bits.
export function fromBase64url(text: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]*$/.test(text) || text.length % 4 === 1) {
    throw new Malformed('not unpadded base64url')
  }
  const binary = atob(text.replaceAll('-', '+').replaceAll('_', '/'))
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0))
  if (base64url(bytes) !== text) throw new Malformed('not canonical base64url')
  return bytes
}
