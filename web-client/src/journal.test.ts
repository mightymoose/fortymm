import { afterEach, expect, test, vi } from 'vitest'
import { loadCore } from './core/load.ts'
import { type DeviceKey, type DeviceKeyFailure, withDeviceKey } from './device-key.ts'
import { commit, type Draft } from './journal.ts'
import type { Store } from './storage.ts'

// The parts of commit that need no real browser: the typed failure when the
// core, the device key, storage or Web Locks is missing, and that nothing
// throws. withDeviceKey and loadCore are replaced; what a commit keeps in
// real IndexedDB, with the real key, is in the browser suite
// (e2e/tests/journal.spec.ts).

vi.mock('./device-key.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./device-key.ts')>()),
  withDeviceKey: vi.fn(),
}))

const bytes = (hex: string) =>
  Uint8Array.from(hex.match(/../g) ?? [], (pair) => parseInt(pair, 16))

// A public key from the core's golden vectors (core/vectors/vectors.json).
const key: DeviceKey = {
  publicKey: bytes('020217e617f0b6443928278f96999e69a23a4f2c152bdf6d6cdf66e5b80282d4ed'),
  sign: () => Promise.reject(new Error('Not signing here')),
}

// A held store that answers each call as given and records what was
// appended.
function storeAnswering(answers: Partial<Store>): Store & { appended: Uint8Array[][] } {
  const appended: Uint8Array[][] = []
  return {
    appended,
    storeRecord: () => Promise.reject(new Error('storeRecord was called')),
    loadUser: () => Promise.reject(new Error('loadUser was called')),
    append: async (records) => {
      appended.push(records)
      return { ok: true }
    },
    loadMatch: async () => ({ ok: true, match: null }),
    ...answers,
  }
}

// withDeviceKey running its callback with the key above and this store.
function withKeyAndStore(store: Store) {
  vi.mocked(withDeviceKey).mockImplementation(async (callback) => ({
    ok: true,
    value: await callback(key, store),
  }))
}

// A draft that makes nothing and keeps nothing, and says whether it ran.
function emptyDraft() {
  const draft = vi.fn<Draft<string>>(async () => ({ records: [], value: 'drafted' }))
  return draft
}

afterEach(() => {
  vi.mocked(withDeviceKey).mockReset()
})

test('when the shared core doesn’t load, a commit is core-unavailable, without throwing, and asks for no key and runs no draft', async () => {
  vi.mocked(loadCore).mockRejectedValue(new Error('No core'))
  const draft = emptyDraft()

  await expect(commit(draft)).resolves.toEqual({ ok: false, reason: 'core-unavailable' })
  expect(withDeviceKey).not.toHaveBeenCalled()
  expect(draft).not.toHaveBeenCalled()
})

test.each<DeviceKeyFailure>(['signing-unavailable', 'storage-unavailable', 'locks-unavailable'])(
  'when withDeviceKey is %s, a commit answers the same, without throwing, and runs no draft',
  async (reason) => {
    vi.mocked(withDeviceKey).mockResolvedValue({ ok: false, reason })
    const draft = emptyDraft()

    await expect(commit(draft)).resolves.toEqual({ ok: false, reason })
    expect(draft).not.toHaveBeenCalled()
  },
)

test('when the append is storage-unavailable (a failed transaction), a commit answers the same, without throwing', async () => {
  withKeyAndStore(
    storeAnswering({ append: async () => ({ ok: false, reason: 'storage-unavailable' }) }),
  )

  await expect(commit(emptyDraft())).resolves.toEqual({
    ok: false,
    reason: 'storage-unavailable',
  })
})

test('when the draft’s read is storage-unavailable, a commit answers the same, without throwing, and appends nothing', async () => {
  const store = storeAnswering({
    loadMatch: async () => ({ ok: false, reason: 'storage-unavailable' }),
  })
  withKeyAndStore(store)

  const result = await commit(async ({ store }) => {
    const loaded = await store.loadMatch('00'.repeat(32))
    if (!loaded.ok) return loaded
    return { records: [], value: 'drafted' }
  })

  expect(result).toEqual({ ok: false, reason: 'storage-unavailable' })
  expect(store.appended).toEqual([])
})

test('a draft’s store only reads: it has loadMatch, and nothing that writes', async () => {
  withKeyAndStore(storeAnswering({}))
  let given: object | undefined

  await commit(async ({ store }) => {
    given = store
    return { records: [], value: 'drafted' }
  })

  expect(Object.keys(given ?? {})).toEqual(['loadMatch'])
})
