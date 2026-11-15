import { screen } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { announce } from '../changes.ts'
import { launchAtStartup } from '../first-launch.ts'
import { loadMe, type LoadUserResult, type User } from '../storage.ts'
import { userStore } from '../stores/user.ts'
import { renderScreen } from '../test/render-screen.tsx'
import { Settings } from './Settings.tsx'
import { SettingsScreenPage } from './settings/SettingsScreen.page.tsx'

// The settings page connected to the real user store (src/stores/user.ts):
// it shows whatever the store reads. Only the storage the store reads is
// replaced (loadMe; jsdom has no IndexedDB), and changes are announced with
// the real announce. What the screen shows for each account is the screen's
// test (SettingsScreen.test.tsx); the store's reads, the store's test
// (src/stores/user.test.ts).
vi.mock('../storage.ts', () => ({ loadMe: vi.fn(), storeRecord: vi.fn() }))
// The launch at startup, so a test can hold it, as the core's module
// arriving late does.
vi.mock('../first-launch.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../first-launch.ts')>()),
  launchAtStartup: vi.fn(() => Promise.resolve()),
}))

const user: User = {
  playerId: 'ab'.repeat(32),
  accountId: 'cd'.repeat(32),
  username: 'brisk-otter-0042',
  publicKey: '02' + 'ef'.repeat(32),
  unconfirmed: true,
}

// First in the file: the app's one store is not read yet, as at app start.
// No loader runs here, so only the store's launch reads the user.
test('on a device with a user kept, a connected page shows the username while the launch at startup is still held back', async () => {
  vi.mocked(loadMe).mockResolvedValue({ ok: true, user })
  let settle!: () => void
  vi.mocked(launchAtStartup).mockReturnValue(new Promise((done) => (settle = done)))
  renderScreen(<Settings />)

  const launching = userStore.getState().launch()

  expect(await new SettingsScreenPage().username()).toHaveTextContent(user.username)
  settle()
  await launching
})

test('the settings page that said there is no account yet shows the username once the store reads one, with no pending view while it reads', async () => {
  vi.mocked(loadMe).mockResolvedValue({ ok: true, user: null })
  await userStore.getState().load()
  renderScreen(<Settings />)
  const page = new SettingsScreenPage()
  expect(await page.noAccount()).toBeVisible()
  vi.mocked(loadMe).mockClear()
  let read!: (loaded: LoadUserResult) => void
  vi.mocked(loadMe).mockReturnValue(new Promise((done) => (read = done)))

  announce({ account: true, matches: [], revision: 0 })
  await vi.waitFor(() => expect(loadMe).toHaveBeenCalledTimes(1))

  expect(await page.noAccount()).toBeVisible()
  expect(
    screen.queryByRole('heading', { name: 'Reading this device’s account' }),
  ).toBeNull()
  read({ ok: true, user })
  expect(await page.username()).toHaveTextContent(user.username)
})
