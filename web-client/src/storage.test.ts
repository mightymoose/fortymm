import { afterEach, expect, test, vi } from 'vitest'
import { loadCore } from './core/load.ts'
import {
  heldStore,
  loadMatch,
  loadMatches,
  loadMe,
  loadUser,
  rebuildViews,
  storeRecord,
} from './storage.ts'

// The parts of storage that need no real browser: which records it refuses,
// and the typed failure when the browser has no usable IndexedDB or Web Locks.
// What is kept, read back, written together and kept once is proven against
// real IndexedDB in the browser suite (e2e/tests/storage.spec.ts).

const bytes = (hex: string) =>
  Uint8Array.from(hex.match(/../g) ?? [], (pair) => parseInt(pair, 16))

// From the core's golden vectors (core/vectors/vectors.json): "records",
// "hello" and "player", and "unverifiable_records",
// "environment-changed-after-signing" (the same hello with one byte changed
// after it was signed).
const signer = '020217e617f0b6443928278f96999e69a23a4f2c152bdf6d6cdf66e5b80282d4ed'
const hello = bytes(
  '825835a500010101020203582102' +
    signer.slice(2) +
    '044801a0a1a2a3a4a5015840995a4632ad56c0b47bf42a57210219a7465aa0cf052fc12d47321d5239759e17666a42cc07fa76e9f7d2d7661c95e0bdbe101c9baf2ed0ef26867dfd7934289c',
)
const player = bytes(
  '825835a500010102020203582102' +
    signer.slice(2) +
    '044802a0a1a2a3a4a5025840e17f35e5cd9900ada05fbfc3ae84bca04604b0b3d329034302b575be9c3946ad5a9e06ca7dbdbec276a0490eb567cd53452fd6f1aa4168f4f25856ab9ebe2779',
)
const unverifiableHello = bytes(
  '825835a500010101020103582102' +
    signer.slice(2) +
    '044801a0a1a2a3a4a5015840995a4632ad56c0b47bf42a57210219a7465aa0cf052fc12d47321d5239759e17666a42cc07fa76e9f7d2d7661c95e0bdbe101c9baf2ed0ef26867dfd7934289c',
)

const somePlayer = '00'.repeat(32)

// IndexedDB stand-ins: jsdom has none.
const refusingIndexedDB = {
  open() {
    const request: Partial<IDBOpenDBRequest> = {}
    setTimeout(() => {
      Object.assign(request, { error: new DOMException('Refused', 'UnknownError') })
      request.onerror?.call(request as IDBOpenDBRequest, new Event('error'))
    })
    return request
  },
}
const untouchedIndexedDB = {
  open: () => {
    throw new Error('IndexedDB was opened')
  },
}
// Grants the lock at once: storage opens its database only once it holds it.
const locks = {
  request: (_name: string, callback: () => Promise<unknown>) => callback(),
}

afterEach(() => {
  vi.unstubAllGlobals()
})

test('the hello vector verifies, so the refusals below are about the record', async () => {
  const core = await loadCore()
  expect(core.verify(hello)).toBe(true)
  expect(core.introducedKey(hello)).not.toBeNull()
})

test('when the shared core doesn’t load, storing is core-unavailable, and storage is not opened', async () => {
  vi.stubGlobal('indexedDB', untouchedIndexedDB)
  vi.mocked(loadCore).mockRejectedValue(new Error('No core'))

  expect(await storeRecord(hello)).toEqual({ ok: false, reason: 'core-unavailable' })
})

test('a record of another kind is refused as not-a-hello, before storage is opened', async () => {
  vi.stubGlobal('indexedDB', untouchedIndexedDB)

  expect(await storeRecord(player)).toEqual({ ok: false, reason: 'not-a-hello' })
})

test('a hello whose signature doesn’t verify is refused as not-a-hello, before storage is opened', async () => {
  vi.stubGlobal('indexedDB', untouchedIndexedDB)

  expect(await storeRecord(unverifiableHello)).toEqual({
    ok: false,
    reason: 'not-a-hello',
  })
})

test('bytes that are not a record are refused as not-a-hello', async () => {
  vi.stubGlobal('indexedDB', untouchedIndexedDB)

  expect(await storeRecord(bytes('00ff'))).toEqual({
    ok: false,
    reason: 'not-a-hello',
  })
})

test('with no IndexedDB, storing and loading are storage-unavailable', async () => {
  vi.stubGlobal('indexedDB', undefined)

  expect(await storeRecord(hello)).toEqual({
    ok: false,
    reason: 'storage-unavailable',
  })
  expect(await loadUser(somePlayer)).toEqual({ ok: false, reason: 'storage-unavailable' })
})

test('when IndexedDB refuses to open, storing and loading are storage-unavailable', async () => {
  vi.stubGlobal('indexedDB', refusingIndexedDB)
  vi.stubGlobal('navigator', { ...navigator, locks })

  expect(await storeRecord(hello)).toEqual({
    ok: false,
    reason: 'storage-unavailable',
  })
  expect(await loadUser(somePlayer)).toEqual({ ok: false, reason: 'storage-unavailable' })
})

test('with no IndexedDB, loading this device’s user is storage-unavailable', async () => {
  vi.stubGlobal('indexedDB', undefined)

  expect(await loadMe()).toEqual({ ok: false, reason: 'storage-unavailable' })
})

test('when IndexedDB refuses to open, loading this device’s user is storage-unavailable', async () => {
  vi.stubGlobal('indexedDB', refusingIndexedDB)

  expect(await loadMe()).toEqual({ ok: false, reason: 'storage-unavailable' })
})

test('with no Web Locks, storing is locks-unavailable, and storage is not opened', async () => {
  vi.stubGlobal('indexedDB', untouchedIndexedDB)
  vi.stubGlobal('navigator', { ...navigator, locks: undefined })

  expect(await storeRecord(hello)).toEqual({
    ok: false,
    reason: 'locks-unavailable',
  })
})

// The journal and the match view (append, loadMatch, loadMatches,
// rebuildViews): which records append refuses, and the typed failures. What
// is kept, together, once, and read back is in the browser suite
// (e2e/tests/storage-matches.spec.ts).

// From the core's golden vectors: "records", "match" (best of 5, rated),
// "score" (game 1 of that match, 11-9) and "result-first-side" (a kind append
// doesn't keep).
const match = bytes(
  '825883a7000101030202035821020217e617f0b6443928278f96999e69a23a4f2c152bdf6d6cdf66e5b80282d4ed044803a0a1a2a3a4a5030882815820e2286f7cd2dc62c15a00bdb33f6e78167112a99a9f072d066e4e9dd3fc9d1c258158209cc056975c22de85464507a2c3b12ed9837736737e7c4c72fece0566d9491ba909440101050b58404ef144ca8b951a306a118728901761d955872e5fb834ef2477c81f1cb1193d8b558414645ffeb7efd3a17fdcc9e153a435a7059813bc45864fe41f91b7afc386',
)
const score = bytes(
  '825860a9000101040202035821020217e617f0b6443928278f96999e69a23a4f2c152bdf6d6cdf66e5b80282d4ed044805a0a1a2a3a4a505085820fa649c3ab42f04c97aa3652b13a5a3717e7d61946d8e6e3e3ad9460f4f9e6f7d09010a420b090b805840818340cd35da935205f56097fd4ff93fd2088224a180de4d50f269b5fa899c5668d53edb9df03989402a0992601ec03bc2454c541ee7c2530c7a358e6f8ca798',
)
const result = bytes(
  '82588aa8000101050202035821020217e617f0b6443928278f96999e69a23a4f2c152bdf6d6cdf66e5b80282d4ed044807a0a1a2a3a4a50708835820fa649c3ab42f04c97aa3652b13a5a3717e7d61946d8e6e3e3ad9460f4f9e6f7d804a010000030b09070b0b05095820e2286f7cd2dc62c15a00bdb33f6e78167112a99a9f072d066e4e9dd3fc9d1c250a805840b79e5652d69f78bf0385d58a79341c8a5cf47169efc47731b7960fc3abaaf2b53ba13a24d38a32805069f537291d649af717b3a47baa28d3967074e455d1d38a',
)
// The match vector with its environment (the body's key 2) changed from 2 to
// 1 after it was signed, as the core's "environment-changed-after-signing"
// does to a hello.
const unverifiableMatch = bytes(
  '825883a7000101030201035821020217e617f0b6443928278f96999e69a23a4f2c152bdf6d6cdf66e5b80282d4ed044803a0a1a2a3a4a5030882815820e2286f7cd2dc62c15a00bdb33f6e78167112a99a9f072d066e4e9dd3fc9d1c258158209cc056975c22de85464507a2c3b12ed9837736737e7c4c72fece0566d9491ba909440101050b58404ef144ca8b951a306a118728901761d955872e5fb834ef2477c81f1cb1193d8b558414645ffeb7efd3a17fdcc9e153a435a7059813bc45864fe41f91b7afc386',
)
const matchId = 'fa649c3ab42f04c97aa3652b13a5a3717e7d61946d8e6e3e3ad9460f4f9e6f7d'

test('the vectors are what the refusals below take them for: a player, a match and its score that verify, a result, and a match that doesn’t verify', async () => {
  const core = await loadCore()
  const kept = [player, match, score, result]

  expect(kept.map((record) => core.kind(record))).toEqual([
    'player',
    'match',
    'score',
    'result',
  ])
  expect(kept.every((record) => core.verify(record))).toBe(true)
  expect(core.kind(unverifiableMatch)).toBe('match')
  expect(core.verify(unverifiableMatch)).toBe(false)
})

test.each([
  { name: 'a match whose signature doesn’t verify', refused: unverifiableMatch },
  { name: 'a result, a kind append doesn’t keep', refused: result },
  { name: 'a hello, which only storeRecord keeps', refused: hello },
  { name: 'bytes that are not a record', refused: bytes('00ff') },
])(
  'append refuses $name, and the records given with it, before storage is opened',
  async ({ refused }) => {
    vi.stubGlobal('indexedDB', untouchedIndexedDB)

    expect(await heldStore.append([player, match, refused, score])).toEqual({
      ok: false,
      reason: 'record-refused',
    })
  },
)

const matchCalls = [
  { name: 'loadMatch', call: () => loadMatch(matchId) },
  { name: 'loadMatches', call: () => loadMatches() },
  { name: 'the held loadMatch', call: () => heldStore.loadMatch(matchId) },
  { name: 'append', call: () => heldStore.append([player, match, score]) },
  { name: 'rebuildViews', call: () => rebuildViews() },
]

test.each(matchCalls)('with no IndexedDB, $name is storage-unavailable', async ({ call }) => {
  vi.stubGlobal('indexedDB', undefined)

  expect(await call()).toEqual({ ok: false, reason: 'storage-unavailable' })
})

test.each(matchCalls)(
  'when IndexedDB refuses to open, $name is storage-unavailable',
  async ({ call }) => {
    vi.stubGlobal('indexedDB', refusingIndexedDB)
    vi.stubGlobal('navigator', { ...navigator, locks })

    expect(await call()).toEqual({ ok: false, reason: 'storage-unavailable' })
  },
)

test.each([
  { name: 'append', call: () => heldStore.append([player, match, score]) },
  { name: 'rebuildViews', call: () => rebuildViews() },
])(
  'when the shared core doesn’t load, $name is core-unavailable, and storage is not opened',
  async ({ call }) => {
    vi.stubGlobal('indexedDB', untouchedIndexedDB)
    vi.mocked(loadCore).mockRejectedValue(new Error('No core'))

    expect(await call()).toEqual({ ok: false, reason: 'core-unavailable' })
  },
)

test('with no Web Locks, rebuildViews is locks-unavailable, and storage is not opened', async () => {
  vi.stubGlobal('indexedDB', untouchedIndexedDB)
  vi.stubGlobal('navigator', { ...navigator, locks: undefined })

  expect(await rebuildViews()).toEqual({ ok: false, reason: 'locks-unavailable' })
})
