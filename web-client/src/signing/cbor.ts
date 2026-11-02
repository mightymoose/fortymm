import { concatBytes, equalBytes, type Bytes } from './bytes'

// The CBOR (RFC 8949) that the signed result format uses, and nothing more:
// integers, byte and text strings, arrays, maps, tags, true and false. The
// encoder writes the core deterministic encoding. The decoder refuses
// anything else, such as a float, null or an indefinite length, and refuses
// bytes that aren't deterministic.
//
// A decoded integer is always a bigint and a map always a Map, so 1, 1.0,
// true and "1" stay apart, as the format needs.
export type Cbor = number | bigint | boolean | string | Bytes | Cbor[] | CborMap | Tagged
export type CborMap = Map<Cbor, Cbor>

export class Tagged {
  readonly tag: number
  readonly item: Cbor

  constructor(tag: number, item: Cbor) {
    this.tag = tag
    this.item = item
  }
}

export class CborError extends Error {}

const UINT_LIMIT = 1n << 64n

export function encode(item: Cbor): Bytes {
  if (typeof item === 'number') {
    if (!Number.isSafeInteger(item)) throw new CborError(`Not an integer: ${item}`)
    return encode(BigInt(item))
  }
  if (typeof item === 'bigint') {
    return item >= 0n ? head(0, item) : head(1, -1n - item)
  }
  if (typeof item === 'boolean') return Uint8Array.of(item ? 0xf5 : 0xf4)
  if (typeof item === 'string') {
    const text = new TextEncoder().encode(item)
    return concatBytes(head(3, BigInt(text.length)), text)
  }
  if (ArrayBuffer.isView(item)) return concatBytes(head(2, BigInt(item.length)), item)
  if (Array.isArray(item)) return concatBytes(head(4, BigInt(item.length)), ...item.map(encode))
  if (item instanceof Map) {
    const entries = [...item].map(([key, value]) => [encode(key), encode(value)] as const)
    entries.sort(([a], [b]) => compareBytes(a, b))
    return concatBytes(head(5, BigInt(entries.length)), ...entries.flat())
  }
  return concatBytes(head(6, BigInt(item.tag)), encode(item.item))
}

// Decodes one deterministic item that fills `bytes`, or throws CborError.
export function decode(bytes: Bytes): Cbor {
  const reader = new Reader(bytes)
  const item = reader.item()
  if (reader.offset !== bytes.length) throw new CborError('Bytes after the item')
  if (!equalBytes(encode(item), bytes)) throw new CborError('Not deterministic')
  return item
}

function head(major: number, argument: bigint): Bytes {
  if (argument >= UINT_LIMIT) throw new CborError('Integer too large')
  const type = major << 5
  if (argument < 24n) return Uint8Array.of(type | Number(argument))
  const size = argument < 0x100n ? 1 : argument < 0x10000n ? 2 : argument < 0x100000000n ? 4 : 8
  const bytes = new Uint8Array(1 + size)
  bytes[0] = type | { 1: 24, 2: 25, 4: 26, 8: 27 }[size]!
  for (let i = size, rest = argument; i > 0; i--, rest >>= 8n) bytes[i] = Number(rest & 0xffn)
  return bytes
}

// Bytewise lexicographic order, the map key order of RFC 8949 section 4.2.1.
function compareBytes(a: Bytes, b: Bytes): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] !== b[i]) return a[i] - b[i]
  }
  return a.length - b.length
}

class Reader {
  offset = 0
  private readonly bytes: Bytes

  constructor(bytes: Bytes) {
    this.bytes = bytes
  }

  item(): Cbor {
    const initial = this.take(1)[0]
    const major = initial >> 5
    const info = initial & 0x1f
    if (major === 7) {
      if (info === 20) return false
      if (info === 21) return true
      throw new CborError('Only true and false are allowed of major type 7')
    }
    const argument = this.argument(info)
    switch (major) {
      case 0:
        return argument
      case 1:
        return -1n - argument
      case 2:
        return this.take(this.length(argument)).slice()
      case 3:
        return new TextDecoder('utf-8', { fatal: true }).decode(this.take(this.length(argument)))
      case 4:
        return Array.from({ length: this.length(argument) }, () => this.item())
      case 5: {
        const map: CborMap = new Map()
        for (let i = this.length(argument); i > 0; i--) map.set(this.item(), this.item())
        return map
      }
      default:
        return new Tagged(Number(argument), this.item())
    }
  }

  private argument(info: number): bigint {
    if (info < 24) return BigInt(info)
    const size = { 24: 1, 25: 2, 26: 4, 27: 8 }[info]
    if (size === undefined) throw new CborError('Indefinite or reserved length')
    return this.take(size).reduce((value, byte) => (value << 8n) | BigInt(byte), 0n)
  }

  // Every item takes at least one byte, so a count past the bytes left is
  // refused before anything is allocated for it.
  private length(argument: bigint): number {
    if (argument > BigInt(this.bytes.length - this.offset)) throw new CborError('Truncated')
    return Number(argument)
  }

  private take(count: number): Bytes {
    if (this.offset + count > this.bytes.length) throw new CborError('Truncated')
    const taken = this.bytes.subarray(this.offset, this.offset + count)
    this.offset += count
    return taken
  }
}
