// Lowercase hex, as every byte field in the API's JSON is.
export function hex(bytes: Uint8Array<ArrayBuffer>): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

export function fromHex(text: string): Uint8Array<ArrayBuffer> {
  if (!/^(?:[0-9a-f]{2})*$/.test(text)) throw new RangeError('not lowercase hex')
  return Uint8Array.from(text.match(/../g) ?? [], (pair) => parseInt(pair, 16))
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

// The 16 bytes of a lowercase, hyphenated UUID, such as an account's id.
export function uuidBytes(uuid: string): Uint8Array<ArrayBuffer> {
  if (!UUID.test(uuid)) throw new RangeError(`${uuid} isn't a lowercase UUID`)
  return fromHex(uuid.replaceAll('-', ''))
}

export function uuidText(bytes: Uint8Array<ArrayBuffer>): string {
  const digits = hex(bytes)
  return [8, 12, 16, 20].reduceRight(
    (text, at) => `${text.slice(0, at)}-${text.slice(at)}`,
    digits,
  )
}

export async function sha256(bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
}
