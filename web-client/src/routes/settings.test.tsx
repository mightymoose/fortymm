import { afterEach, expect, test, vi } from 'vitest'
import { withDeviceKey } from '../device-key.ts'
import { loadMe, storeRecord, type User } from '../storage.ts'
import { SettingsPage } from './settings.page.ts'

// The page's rendering, with the one read it makes replaced: this device's
// user (loadMe, storage.ts). jsdom has no IndexedDB; the real storage under
// this page, the first launch filling it and the page waiting for that
// launch are proven in the browser suite (e2e/tests/settings.spec.ts,
// e2e/tests/storage.spec.ts).
vi.mock('../storage.ts', () => ({ loadMe: vi.fn(), storeRecord: vi.fn() }))
vi.mock('../device-key.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../device-key.ts')>()),
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

test('/settings shows the username of this device’s user', async () => {
  vi.mocked(loadMe).mockResolvedValue({ ok: true, user })
  const page = new SettingsPage()
  await page.render()

  expect(await page.heading()).toBeVisible()
  expect(await page.username()).toHaveTextContent(user.username)
})

test('/settings says there is no account yet when this device has no user, and makes no key and no user', async () => {
  vi.mocked(loadMe).mockResolvedValue({ ok: true, user: null })
  const page = new SettingsPage()
  await page.render()

  expect(await page.noAccount()).toBeVisible()
  expect(withDeviceKey).not.toHaveBeenCalled()
  expect(storeRecord).not.toHaveBeenCalled()
})

test('/settings says it can’t read this device’s storage when the user can’t be read', async () => {
  vi.mocked(loadMe).mockResolvedValue({ ok: false, reason: 'storage-unavailable' })
  const page = new SettingsPage()
  await page.render()

  expect(await page.storageUnavailable()).toBeVisible()
})
