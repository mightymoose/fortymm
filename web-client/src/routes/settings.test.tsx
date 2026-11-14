import { expect, test, vi } from 'vitest'
import { SettingsScreenPage } from '../components/SettingsScreen.page.tsx'
import { loadMe, type User } from '../storage.ts'
import { renderRoute } from '../test/render-route.tsx'

// The route's wiring: its loader's account reaches the screen, and its pending
// view shows while the loader runs. Only the storage it reads is replaced
// (loadMe; jsdom has no IndexedDB). What each account shows is the screen's
// test (src/components/SettingsScreen.test.tsx); how the account is read is
// ownAccount's (src/account.test.ts); the page over real storage is the
// browser suite's (e2e/tests/settings.spec.ts).
vi.mock('../storage.ts', () => ({ loadMe: vi.fn(), storeRecord: vi.fn() }))

const user: User = {
  playerId: 'ab'.repeat(32),
  accountId: 'cd'.repeat(32),
  username: 'brisk-otter-0042',
  publicKey: '02' + 'ef'.repeat(32),
  unconfirmed: true,
}

test('/settings shows the settings screen with this device’s account from its loader', async () => {
  vi.mocked(loadMe).mockResolvedValue({ ok: true, user })
  renderRoute('/settings')

  expect(await new SettingsScreenPage().username()).toHaveTextContent(user.username)
})

// The router shows a pending view only once the loader has run for a while
// (its pendingMs, a second by default), so this waits longer than a finder.
test('/settings shows the settings screen’s pending view while its loader is still reading', async () => {
  vi.mocked(loadMe).mockReturnValue(new Promise(() => {}))
  renderRoute('/settings')
  const page = new SettingsScreenPage()

  await vi.waitFor(() => page.reading(), { timeout: 3_000 })
})
