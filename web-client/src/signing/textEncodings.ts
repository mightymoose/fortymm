import type { Bytes } from './bytes'

// The two text forms of an envelope. Each decoder is strict: the bytes it
// returns encode back to exactly the text it read, or it returns null.

const BASE45 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:'

// Base45, RFC 9285.
export function toBase45(bytes: Bytes): string {
  let text = ''
  for (let i = 0; i < bytes.length; i += 2) {
    const pair = i + 1 < bytes.length
    let value = pair ? bytes[i] * 256 + bytes[i + 1] : bytes[i]
    for (let digits = pair ? 3 : 2; digits > 0; digits--) {
      text += BASE45[value % 45]
      value = Math.floor(value / 45)
    }
  }
  return text
}

export function fromBase45(text: string): Bytes | null {
  if (text.length % 3 === 1) return null
  const bytes: number[] = []
  for (let i = 0; i < text.length; i += 3) {
    const digits = [...text.slice(i, i + 3)].map((char) => BASE45.indexOf(char))
    if (digits.includes(-1)) return null
    const value = digits.reduceRight((total, digit) => total * 45 + digit, 0)
    if (digits.length === 3) {
      if (value > 0xffff) return null
      bytes.push(value >> 8, value & 0xff)
    } else {
      if (value > 0xff) return null
      bytes.push(value)
    }
  }
  return Uint8Array.from(bytes)
}

// base64url, RFC 4648 section 5, without padding.
export function toBase64url(bytes: Bytes): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

export function fromBase64url(text: string): Bytes | null {
  if (!/^[A-Za-z0-9_-]*$/.test(text) || text.length % 4 === 1) return null
  const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/'))
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0))
  // Nonzero spare bits decode too, but encode back to other text.
  return toBase64url(bytes) === text ? bytes : null
}
