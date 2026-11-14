import { afterEach, expect, test, vi } from 'vitest'
import { ownAccount } from './account.ts'
import { withDeviceKey } from './device-key.ts'
import { loadMe, storeRecord, type User } from './storage.ts'

// ownAccount with the one read it makes replaced: this device's user (loadMe,
// storage.ts). jsdom has no IndexedDB; the real storage under it, the first
// launch filling it and /settings waiting for that launch are proven in the
// browser suite (e2e/tests/settings.spec.ts, e2e/tests/storage.spec.ts). No
// launch was started here, so startupLaunchSettled() resolves at once.
vi.mock('./storage.ts', () => ({ loadMe: vi.fn(), storeRecord: vi.fn() }))
vi.mock('./device-key.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./device-key.ts')>()),
  withDeviceKey: vi.fn(),
}))

afterEach(() => {
  for (const replaced of [withDeviceKey, loadMe, storeRecord]) {
    vi.mocked(replaced).mockReset()
  }
})

const user: User = {
  playerId: 'ab'.repeat(32),
  accountId: 'cd'.repeat(32),
  username: 'brisk-otter-0042',
  publicKey: '02' + 'ef'.repeat(32),
  unconfirmed: true,
}

test('ownAccount gives this device’s user when one is stored', async () => {
  vi.mocked(loadMe).mockResolvedValue({ ok: true, user })
  expect(await ownAccount()).toEqual({ state: 'user', user })
})

test('ownAccount reads again after the launch at startup when no user is stored yet', async () => {
  vi.mocked(loadMe)
    .mockResolvedValueOnce({ ok: true, user: null })
    .mockResolvedValueOnce({ ok: true, user })
  expect(await ownAccount()).toEqual({ state: 'user', user })
})

test('ownAccount says there is no account when this device has no user, and makes no key and no user', async () => {
  vi.mocked(loadMe).mockResolvedValue({ ok: true, user: null })
  expect(await ownAccount()).toEqual({ state: 'none' })
  expect(withDeviceKey).not.toHaveBeenCalled()
  expect(storeRecord).not.toHaveBeenCalled()
})

test('ownAccount says storage is unavailable when the user can’t be read', async () => {
  vi.mocked(loadMe).mockResolvedValue({ ok: false, reason: 'storage-unavailable' })
  expect(await ownAccount()).toEqual({ state: 'storage-unavailable' })
})
