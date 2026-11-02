// Bytes backed by an ArrayBuffer, which WebCrypto and IndexedDB take.
export type Bytes = Uint8Array<ArrayBuffer>

export function toHex(bytes: Bytes): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

export function fromHex(hex: string): Bytes {
  if (!/^(?:[0-9a-f]{2})*$/.test(hex)) throw new Error(`Not lowercase hex: ${hex}`)
  return Uint8Array.from(hex.match(/../g) ?? [], (pair) => parseInt(pair, 16))
}

// The 16 bytes of a UUID, such as an account or player id.
export function uuidBytes(uuid: string): Bytes {
  const hex = uuid.toLowerCase()
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(hex)) {
    throw new Error(`Not a UUID: ${uuid}`)
  }
  return fromHex(hex.replace(/-/g, ''))
}

export function uuidString(bytes: Bytes): string {
  const hex = toHex(bytes)
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)]
    .join('-')
}

export function equalBytes(a: Bytes, b: Bytes): boolean {
  return a.length === b.length && a.every((byte, i) => byte === b[i])
}

export function concatBytes(...parts: Bytes[]): Bytes {
  const joined = new Uint8Array(parts.reduce((length, part) => length + part.length, 0))
  let offset = 0
  for (const part of parts) {
    joined.set(part, offset)
    offset += part.length
  }
  return joined
}
