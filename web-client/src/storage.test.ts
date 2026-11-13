import { afterEach, expect, test, vi } from 'vitest'
import { loadCore } from './core/load.ts'
import { loadUser, storeRecord } from './storage.ts'

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
const locks = { request: () => Promise.reject(new Error('unexpected lock')) }

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

test('with no Web Locks, storing is locks-unavailable, and storage is not opened', async () => {
  vi.stubGlobal('indexedDB', untouchedIndexedDB)
  vi.stubGlobal('navigator', { ...navigator, locks: undefined })

  expect(await storeRecord(hello)).toEqual({
    ok: false,
    reason: 'locks-unavailable',
  })
})
