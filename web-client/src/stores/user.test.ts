import { afterEach, expect, test, vi } from 'vitest'
import { announce } from '../changes.ts'
import { withDeviceKey } from '../device-key.ts'
import { launchAtStartup, startupLaunchSettled } from '../first-launch.ts'
import { loadMe, storeRecord, type User } from '../storage.ts'
import { createUserStore } from './user.ts'

// The user store with the one read it makes replaced: this device's user
// (loadMe, storage.ts). jsdom has no IndexedDB; the real storage under it,
// the first launch filling it and /settings following it are proven in the
// browser suite (e2e/tests/settings.spec.ts, e2e/tests/storage.spec.ts).
// Changes are announced with the real announce (src/changes.ts). Each test
// builds a store of its own.
vi.mock('../storage.ts', () => ({ loadMe: vi.fn(), storeRecord: vi.fn() }))
vi.mock('../device-key.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../device-key.ts')>()),
  withDeviceKey: vi.fn(),
}))
// The launch at startup, and the wait for it, so a test can hold them; by
// default both resolve at once, as when no launch was started.
vi.mock('../first-launch.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../first-launch.ts')>()),
  startupLaunchSettled: vi.fn(() => Promise.resolve()),
  launchAtStartup: vi.fn(() => Promise.resolve()),
}))

// Each test's store keeps listening after it; the stores of earlier tests
// read again only on an account change, and get the same answers as the
// test's own.
afterEach(() => {
  for (const replaced of [withDeviceKey, loadMe, storeRecord]) {
    vi.mocked(replaced).mockReset()
  }
  vi.mocked(startupLaunchSettled).mockImplementation(() => Promise.resolve())
  vi.mocked(launchAtStartup).mockImplementation(() => Promise.resolve())
})

const user: User = {
  playerId: 'ab'.repeat(32),
  accountId: 'cd'.repeat(32),
  username: 'brisk-otter-0042',
  publicKey: '02' + 'ef'.repeat(32),
  unconfirmed: true,
}

const accountChanged = { account: true, matches: [], revision: 0 }

test('the user store gives this device’s user when one is stored', async () => {
  vi.mocked(loadMe).mockResolvedValue({ ok: true, user })
  const store = createUserStore()

  await store.getState().load()

  expect(store.getState().user).toEqual({ state: 'user', user })
})

test('the user store says there is no account when this device has no user, and makes no key and no user', async () => {
  vi.mocked(loadMe).mockResolvedValue({ ok: true, user: null })
  const store = createUserStore()

  await store.getState().load()

  expect(store.getState().user).toEqual({ state: 'none' })
  expect(withDeviceKey).not.toHaveBeenCalled()
  expect(storeRecord).not.toHaveBeenCalled()
})

test('the user store says storage is unavailable when the user can’t be read', async () => {
  vi.mocked(loadMe).mockResolvedValue({ ok: false, reason: 'storage-unavailable' })
  const store = createUserStore()

  await store.getState().load()

  expect(store.getState().user).toEqual({ state: 'storage-unavailable' })
})

test('with no user stored yet, load waits for the launch at startup, then reads again, making nothing', async () => {
  let settle!: () => void
  vi.mocked(startupLaunchSettled).mockReturnValue(new Promise((done) => (settle = done)))
  vi.mocked(loadMe)
    .mockResolvedValueOnce({ ok: true, user: null })
    .mockResolvedValueOnce({ ok: true, user })
  const store = createUserStore()

  const loading = store.getState().load()
  await vi.waitFor(() => expect(startupLaunchSettled).toHaveBeenCalled())
  expect(loadMe).toHaveBeenCalledTimes(1)
  expect(store.getState().user).toEqual({ state: 'unread' })

  settle()
  await loading
  expect(loadMe).toHaveBeenCalledTimes(2)
  expect(store.getState().user).toEqual({ state: 'user', user })
  expect(withDeviceKey).not.toHaveBeenCalled()
  expect(storeRecord).not.toHaveBeenCalled()
})

test('after a change to this device’s account, the user is read again', async () => {
  vi.mocked(loadMe).mockResolvedValue({ ok: true, user: null })
  const store = createUserStore()
  await store.getState().load()
  vi.mocked(loadMe).mockResolvedValue({ ok: true, user })

  announce(accountChanged)

  await vi.waitFor(() => expect(store.getState().user).toEqual({ state: 'user', user }))
})

test('a change that is not to this device’s account is ignored: the user is not read again', async () => {
  vi.mocked(loadMe).mockResolvedValue({ ok: true, user })
  const store = createUserStore()
  await store.getState().load()
  vi.mocked(loadMe).mockClear()

  announce({ account: false, matches: ['01'.repeat(32)], revision: 0 })
  await new Promise((resolve) => setTimeout(resolve, 0))

  expect(loadMe).not.toHaveBeenCalled()
  expect(store.getState().user).toEqual({ state: 'user', user })
})

test('with a user kept on this device, launch gives the store the user before the launch at startup settles', async () => {
  vi.mocked(loadMe).mockResolvedValue({ ok: true, user })
  let settle!: () => void
  vi.mocked(launchAtStartup).mockReturnValue(new Promise((done) => (settle = done)))
  const store = createUserStore()

  const launching = store.getState().launch()

  await vi.waitFor(() => expect(store.getState().user).toEqual({ state: 'user', user }))
  expect(launchAtStartup).toHaveBeenCalled()
  settle()
  await launching
})

test('once the launch at startup has settled, launch reads the user again', async () => {
  vi.mocked(loadMe).mockResolvedValue({ ok: true, user: null })
  let settle!: () => void
  vi.mocked(launchAtStartup).mockReturnValue(new Promise((done) => (settle = done)))
  const store = createUserStore()
  const launching = store.getState().launch()
  await vi.waitFor(() => expect(store.getState().user).toEqual({ state: 'none' }))
  vi.mocked(loadMe).mockResolvedValue({ ok: true, user })

  settle()
  await launching

  expect(store.getState().user).toEqual({ state: 'user', user })
})
