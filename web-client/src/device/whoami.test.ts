/// <reference types="node" />
import { readFileSync } from 'node:fs'
import { afterEach, beforeAll, describe, expect, vi } from 'vitest'
import { loadCore, type Core } from '../core/load-core.ts'
import { it } from '../setupTests.ts'
import { deviceKey } from './device-key.ts'
import { identityOf, whoami } from './whoami.ts'

// jsdom has no IndexedDB or Web Locks, so the kept key is stood in for here; finding the same
// identity again in a real browser, across reloads and tabs, is proven through the screens that
// show it. The identity itself is checked against the core's golden vectors (core/vectors), which
// the Rust and Python builds check too.
vi.mock('./device-key.ts')

type KeyVector = {
  name: string
  uncompressed_public_key: string
  account_id: string
  own_player_id: string
}
type Vectors = {
  keys: KeyVector[]
  usernames: { player_id: string; suffix_length: number; username: string }[]
}

const vectors = JSON.parse(
  readFileSync('node_modules/fortymm-core-wasm/vectors.json', 'utf8'),
) as Vectors

function bytes(hex: string): Uint8Array {
  return Uint8Array.from(hex.match(/../g) ?? [], (pair) => Number.parseInt(pair, 16))
}

// The vectors' four-character username for a player.
function provisionalUsername(playerId: string): string | undefined {
  return vectors.usernames.find(
    (entry) => entry.player_id === playerId && entry.suffix_length === 4,
  )?.username
}

let core: Core
beforeAll(async () => {
  core = await loadCore()
})

afterEach(() => {
  vi.mocked(deviceKey).mockReset()
})

describe.each(vectors.keys)('identityOf key $name', (key) => {
  it("is the key's account", () => {
    expect(identityOf(bytes(key.uncompressed_public_key), core).accountId).toBe(key.account_id)
  })

  it("is the key's own player", () => {
    expect(identityOf(bytes(key.uncompressed_public_key), core).playerId).toBe(key.own_player_id)
  })

  it("has the player's provisional username", () => {
    expect(identityOf(bytes(key.uncompressed_public_key), core).username).toBe(
      provisionalUsername(key.own_player_id),
    )
  })
})

describe('identityOf', () => {
  it('is a guest, until the server says otherwise', () => {
    const [alice] = vectors.keys
    expect(identityOf(bytes(alice!.uncompressed_public_key), core).account).toBe('guest')
  })

  it('has an unconfirmed username, until the server confirms it', () => {
    const [alice] = vectors.keys
    expect(identityOf(bytes(alice!.uncompressed_public_key), core).usernameConfirmed).toBe(false)
  })
})

describe('whoami', () => {
  async function keptKey() {
    const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, [
      'sign',
      'verify',
    ])
    vi.mocked(deviceKey).mockResolvedValue({ ok: true, outcome: 'kept', pair })
  }

  it('has an identity once the device has a key', async () => {
    await keptKey()
    expect((await whoami()).ok).toBe(true)
  })

  it("passes on why the device has no key", async () => {
    vi.mocked(deviceKey).mockResolvedValue({ ok: false, reason: 'storage-unavailable' })
    expect(await whoami()).toEqual({ ok: false, reason: 'storage-unavailable' })
  })

  it("is core-unavailable when the core's wasm fails to load", async () => {
    await keptKey()
    vi.mocked(loadCore).mockRejectedValueOnce(new Error('No wasm'))
    expect(await whoami()).toEqual({ ok: false, reason: 'core-unavailable' })
  })
})
