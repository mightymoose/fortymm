import { screen } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { announce } from '../changes.ts'
import { loadMe, type LoadUserResult, type User } from '../storage.ts'
import { userStore } from '../stores/user.ts'
import { renderScreen } from '../test/render-screen.tsx'
import { Settings } from './Settings.tsx'
import { SettingsScreenPage } from './SettingsScreen.page.tsx'

// The settings page connected to the real user store (src/stores/user.ts):
// it follows the store while mounted. Only the storage the store reads is
// replaced (loadMe; jsdom has no IndexedDB), and changes are announced with
// the real announce. What the screen shows for each account is the screen's
// test (SettingsScreen.test.tsx); the store's reads, the store's test
// (src/stores/user.test.ts).
vi.mock('../storage.ts', () => ({ loadMe: vi.fn(), storeRecord: vi.fn() }))

const user: User = {
  playerId: 'ab'.repeat(32),
  accountId: 'cd'.repeat(32),
  username: 'brisk-otter-0042',
  publicKey: '02' + 'ef'.repeat(32),
  unconfirmed: true,
}

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
