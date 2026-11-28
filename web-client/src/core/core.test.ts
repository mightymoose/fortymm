/// <reference types="node" />
// The core's wasm package (core/bindings/wasm), built into the image, checked against the core's
// golden vectors (core/vectors/vectors.json, shipped beside the .wasm): the same file the Rust and
// Python builds check, so all three compute the same ids and usernames. Tests load the module's
// bytes from disk: jsdom has no fetch for file URLs, which init() would use.
import { readFileSync } from 'node:fs'
import {
  account_id,
  compress_public_key,
  hello_world,
  initSync,
  own_player_id,
  username,
} from 'fortymm-core-wasm'
import { beforeAll, describe, expect } from 'vitest'
import { it } from '../setupTests.ts'

type KeyVector = {
  name: string
  uncompressed_public_key: string
  public_key: string
  account_id: string
  own_player_id: string
}
type UsernameVector = { player_id: string; suffix_length: number; username: string }
type Vectors = {
  keys: KeyVector[]
  invalid_uncompressed_public_keys: { name: string; public_key: string }[]
  usernames: UsernameVector[]
  invalid_username_suffix_lengths: number[]
}

const vectors = JSON.parse(
  readFileSync('node_modules/fortymm-core-wasm/vectors.json', 'utf8'),
) as Vectors

function bytes(hex: string): Uint8Array {
  return Uint8Array.from(hex.match(/../g) ?? [], (pair) => Number.parseInt(pair, 16))
}

function hex(data: Uint8Array): string {
  return Array.from(data, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

beforeAll(() => {
  initSync({ module: readFileSync('node_modules/fortymm-core-wasm/fortymm_core_wasm_bg.wasm') })
})

describe('the core', () => {
  it('greets the world', () => {
    expect(hello_world()).toBe('Hello World')
  })

  describe.each(vectors.keys)('for key $name', (key) => {
    it('compresses the exported public key', () => {
      expect(hex(compress_public_key(bytes(key.uncompressed_public_key)))).toBe(key.public_key)
    })

    it('computes the account id', () => {
      expect(hex(account_id(bytes(key.public_key)))).toBe(key.account_id)
    })

    it('computes the own player id', () => {
      expect(hex(own_player_id(bytes(key.public_key)))).toBe(key.own_player_id)
    })
  })

  it.each(vectors.invalid_uncompressed_public_keys)(
    'refuses the malformed exported public key $name',
    (key) => {
      expect(() => compress_public_key(bytes(key.public_key))).toThrow()
    },
  )

  it.each(vectors.usernames)(
    'names player $player_id with a $suffix_length-character suffix',
    (entry) => {
      expect(username(bytes(entry.player_id), entry.suffix_length)).toBe(entry.username)
    },
  )

  it.each(vectors.invalid_username_suffix_lengths)(
    'refuses a suffix of %i characters',
    (length) => {
      expect(() => username(new Uint8Array(32), length)).toThrow()
    },
  )

  it('refuses a player id that is not 32 bytes', () => {
    expect(() => username(new Uint8Array(31), 4)).toThrow()
  })
})
