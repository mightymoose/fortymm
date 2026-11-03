// The CBOR items the signed result format uses (api/signed-results/README.md).
// Integers are JS numbers, so each must be a safe integer. A map's keys are
// integers or text, and a Map keeps the integer 1 apart from the text "1".
export type Cbor = number | boolean | string | Uint8Array<ArrayBuffer> | Cbor[] | CborMap | Tagged
export type CborMap = Map<number | string, Cbor>
export type Tagged = { tag: number; value: Cbor }

// The bytes aren't this format. The message says which rule failed, for
// people. No caller matches on it.
export class Malformed extends Error {
  readonly code = 'malformed'
}

const UNSIGNED = 0
const NEGATIVE = 1
const BYTES = 2
const TEXT = 3
const ARRAY = 4
const MAP = 5
const TAG = 6
const SIMPLE = 7
const FALSE = 20
const TRUE = 21

// Deterministic CBOR (RFC 8949 section 4.2.1): shortest heads, definite
// lengths, and map keys sorted by their encoded bytes.
export function encode(value: Cbor): Uint8Array<ArrayBuffer> {
  const out: number[] = []
  write(out, value)
  return Uint8Array.from(out)
}

function write(out: number[], value: Cbor): void {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new RangeError(`${value} isn't a safe integer`)
    if (value >= 0) head(out, UNSIGNED, value)
    else head(out, NEGATIVE, -1 - value)
  } else if (typeof value === 'boolean') {
    out.push((SIMPLE << 5) | (value ? TRUE : FALSE))
  } else if (typeof value === 'string') {
    const bytes = new TextEncoder().encode(value)
    head(out, TEXT, bytes.length)
    out.push(...bytes)
  } else if (ArrayBuffer.isView(value)) {
    // Not `instanceof Uint8Array`: under jsdom, the arrays that TextEncoder,
    // WebCrypto and IndexedDB make come from another realm.
    head(out, BYTES, value.length)
    out.push(...value)
  } else if (Array.isArray(value)) {
    head(out, ARRAY, value.length)
    for (const item of value) write(out, item)
  } else if (value instanceof Map) {
    const entries = [...value].map(([key, item]) => [encode(key), encode(item)])
    entries.sort(([a], [b]) => compareBytes(a, b))
    head(out, MAP, entries.length)
    for (const [key, item] of entries) out.push(...key, ...item)
  } else {
    head(out, TAG, value.tag)
    write(out, value.value)
  }
}

function head(out: number[], major: number, argument: number): void {
  const type = major << 5
  if (argument < 24) out.push(type | argument)
  else if (argument < 0x100) out.push(type | 24, argument)
  else if (argument < 0x10000) out.push(type | 25, argument >> 8, argument & 0xff)
  else if (argument < 0x100000000) out.push(type | 26, ...bigEndian(argument, 4))
  else out.push(type | 27, ...bigEndian(argument, 8))
}

function bigEndian(n: number, size: number): number[] {
  const bytes: number[] = []
  for (let i = 0; i < size; i++) {
    bytes.unshift(n % 256)
    n = Math.floor(n / 256)
  }
  return bytes
}

function compareBytes(a: Uint8Array<ArrayBuffer>, b: Uint8Array<ArrayBuffer>): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] !== b[i]) return a[i] - b[i]
  }
  return a.length - b.length
}

export function equalBytes(a: Uint8Array<ArrayBuffer>, b: Uint8Array<ArrayBuffer>): boolean {
  return a.length === b.length && compareBytes(a, b) === 0
}

// One deterministic CBOR item. Throws Malformed for anything this format
// never writes: a float, null or undefined, an indefinite length, an integer
// outside the safe range, a map key that isn't an integer or text, or
// trailing bytes. Then it encodes the item again and compares, which refuses
// a head that isn't shortest and duplicate or unsorted map keys. The caller
// checks each item's type against the format's tables.
export function decode(bytes: Uint8Array<ArrayBuffer>): Cbor {
  const reader = new Reader(bytes)
  const value = reader.item()
  if (reader.offset !== bytes.length) throw new Malformed('trailing bytes')
  if (!equalBytes(encode(value), bytes)) throw new Malformed('not deterministic CBOR')
  return value
}

// The format nests at most five levels deep, so a deeper item is refused
// before it can exhaust the stack.
const MAX_DEPTH = 16

const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

class Reader {
  offset = 0
  private readonly bytes: Uint8Array<ArrayBuffer>

  constructor(bytes: Uint8Array<ArrayBuffer>) {
    this.bytes = bytes
  }

  item(depth = 0): Cbor {
    if (depth > MAX_DEPTH) throw new Malformed('nested too deeply')
    const initial = this.take(1)[0]
    const major = initial >> 5
    const info = initial & 0x1f
    if (major === SIMPLE) {
      if (info === FALSE) return false
      if (info === TRUE) return true
      throw new Malformed('a float or a simple value other than true or false')
    }
    const argument = this.argument(info)
    switch (major) {
      case UNSIGNED:
        return argument
      case NEGATIVE:
        if (argument >= Number.MAX_SAFE_INTEGER) throw new Malformed('an integer out of range')
        return -1 - argument
      case BYTES:
        return Uint8Array.from(this.take(argument))
      case TEXT:
        try {
          return utf8.decode(this.take(argument))
        } catch {
          throw new Malformed('text that isn\'t UTF-8')
        }
      case ARRAY:
        return Array.from({ length: this.count(argument) }, () => this.item(depth + 1))
      case MAP: {
        const map: CborMap = new Map()
        for (let i = this.count(argument); i > 0; i--) {
          const key = this.item(depth + 1)
          if (typeof key !== 'number' && typeof key !== 'string') {
            throw new Malformed('a map key isn\'t an integer or text')
          }
          map.set(key, this.item(depth + 1))
        }
        return map
      }
      default:
        return { tag: argument, value: this.item(depth + 1) }
    }
  }

  private argument(info: number): number {
    if (info < 24) return info
    const size = { 24: 1, 25: 2, 26: 4, 27: 8 }[info]
    if (size === undefined) throw new Malformed('an indefinite length or a reserved head')
    const n = this.take(size).reduce((total, byte) => total * 256 + byte, 0)
    if (!Number.isSafeInteger(n)) throw new Malformed('an integer out of range')
    return n
  }

  // Each item takes at least one byte, so a count beyond the bytes left is
  // refused before anything is allocated for it.
  private count(n: number): number {
    if (n > this.bytes.length - this.offset) throw new Malformed('a count beyond the bytes left')
    return n
  }

  private take(n: number): Uint8Array<ArrayBuffer> {
    if (this.offset + n > this.bytes.length) throw new Malformed('the bytes end too soon')
    const taken = this.bytes.subarray(this.offset, this.offset + n)
    this.offset += n
    return taken
  }
}

// Checks of a decoded item against the format's tables. Each throws
// Malformed for an item of another type or shape.

// A map whose keys are exactly `required`, plus any of `optional`.
export function exactKeys(
  value: Cbor | undefined,
  required: (number | string)[],
  optional: (number | string)[] = [],
): CborMap {
  if (!(value instanceof Map)) throw new Malformed('not a map')
  const allowed = [...required, ...optional]
  const keys = [...value.keys()]
  if (!required.every((key) => value.has(key)) || !keys.every((key) => allowed.includes(key))) {
    throw new Malformed(`the map's keys are ${keys.join(', ')}`)
  }
  return value
}

export function uint(value: Cbor | undefined): number {
  if (typeof value !== 'number' || value < 0) throw new Malformed('not an unsigned integer')
  return value
}

// An index into a result's players.
export type Side = 0 | 1

export function side(value: Cbor | undefined): Side {
  if (value === 0 || value === 1) return value
  throw new Malformed('a side isn\'t 0 or 1')
}

export function bstr(value: Cbor | undefined, length: number): Uint8Array<ArrayBuffer> {
  if (!ArrayBuffer.isView(value) || value.length !== length) {
    throw new Malformed(`not a byte string of ${length} bytes`)
  }
  return value
}

export function array(value: Cbor | undefined, length?: number): Cbor[] {
  if (!Array.isArray(value) || (length !== undefined && value.length !== length)) {
    throw new Malformed(length === undefined ? 'not an array' : `not an array of ${length}`)
  }
  return value
}
