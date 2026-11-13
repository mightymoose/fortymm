import { afterEach, expect, test, vi } from 'vitest'
import { loadCore } from '../core/load.ts'
import { keptPublicKey, withDeviceKey } from '../device-key.ts'
import { loadUser, storeRecord, type User } from '../storage.ts'
import { SettingsPage } from './settings.page.ts'

// The page's rendering, with what it reads from the device replaced: the kept
// key (device-key.ts) and the stored user (storage.ts). jsdom has no
// IndexedDB; the real storage under this page is proven in the browser suite
// (e2e/tests/settings.spec.ts, e2e/tests/storage.spec.ts). The core is real,
// so the page asks for the user by the player id the core gives for the key.
vi.mock('../storage.ts', () => ({ loadUser: vi.fn(), storeRecord: vi.fn() }))
vi.mock('../device-key.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../device-key.ts')>()),
  keptPublicKey: vi.fn(),
  withDeviceKey: vi.fn(),
}))

afterEach(() => {
  for (const replaced of [keptPublicKey, withDeviceKey, loadUser, storeRecord]) {
    vi.mocked(replaced).mockReset()
  }
})

const bytes = (hex: string) =>
  Uint8Array.from(hex.match(/../g) ?? [], (pair) => parseInt(pair, 16))
const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')

// A key from the core's golden vectors ("keys", alice).
const publicKey = bytes(
  '020217e617f0b6443928278f96999e69a23a4f2c152bdf6d6cdf66e5b80282d4ed',
)

async function storedUserFor(key: Uint8Array): Promise<User> {
  const core = await loadCore()
  const playerId = core.ownPlayerId(key)
  return {
    playerId: hex(playerId),
    accountId: hex(core.accountId(key)),
    username: core.username(playerId, 4),
    publicKey: hex(key),
    unconfirmed: true,
  }
}

test('/settings shows the username of the user stored for this device’s key', async () => {
  const user = await storedUserFor(publicKey)
  vi.mocked(keptPublicKey).mockResolvedValue({ ok: true, publicKey })
  vi.mocked(loadUser).mockImplementation(async (playerId) => ({
    ok: true,
    user: playerId === user.playerId ? user : null,
  }))
  const page = new SettingsPage()
  await page.render()

  expect(await page.heading()).toBeVisible()
  expect(await page.username()).toHaveTextContent(user.username)
})

test('/settings says there is no account yet when no key is kept, and makes no key and no user', async () => {
  vi.mocked(keptPublicKey).mockResolvedValue({ ok: true, publicKey: null })
  const page = new SettingsPage()
  await page.render()

  expect(await page.noAccount()).toBeVisible()
  expect(withDeviceKey).not.toHaveBeenCalled()
  expect(storeRecord).not.toHaveBeenCalled()
})

test('/settings says there is no account yet when no user is stored for the key, and makes none', async () => {
  vi.mocked(keptPublicKey).mockResolvedValue({ ok: true, publicKey })
  vi.mocked(loadUser).mockResolvedValue({ ok: true, user: null })
  const page = new SettingsPage()
  await page.render()

  expect(await page.noAccount()).toBeVisible()
  expect(withDeviceKey).not.toHaveBeenCalled()
  expect(storeRecord).not.toHaveBeenCalled()
})

test('/settings says it can’t read this device’s storage when the key can’t be read', async () => {
  vi.mocked(keptPublicKey).mockResolvedValue({ ok: false, reason: 'storage-unavailable' })
  const page = new SettingsPage()
  await page.render()

  expect(await page.storageUnavailable()).toBeVisible()
})

test('/settings says it can’t read this device’s storage when the user can’t be read', async () => {
  vi.mocked(keptPublicKey).mockResolvedValue({ ok: true, publicKey })
  vi.mocked(loadUser).mockResolvedValue({ ok: false, reason: 'storage-unavailable' })
  const page = new SettingsPage()
  await page.render()

  expect(await page.storageUnavailable()).toBeVisible()
})

test('/settings says the shared core did not load when loading it fails', async () => {
  vi.mocked(keptPublicKey).mockResolvedValue({ ok: true, publicKey })
  vi.mocked(loadCore).mockRejectedValue(new Error('No core'))
  const page = new SettingsPage()
  await page.render()

  expect(await page.coreUnavailable()).toBeVisible()
})
