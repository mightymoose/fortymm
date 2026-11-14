import { expect, test, vi } from 'vitest'
import { announce } from '../changes.ts'
import { loadMe, type LoadUserResult, type User } from '../storage.ts'
import { userStore } from '../stores/user.ts'
import { AppLayoutPage } from './AppLayout.page.tsx'

// The top bar's user mark connected to the real user store
// (src/stores/user.ts), in the layout that is always mounted. Only the
// storage the store reads is replaced (loadMe; jsdom has no IndexedDB), and
// changes are announced with the real announce. What the mark shows for a
// username is UserMarkLink.test.tsx; the store's reads, its own test. The
// tests share the app's one store, so they run in order: unread first.
vi.mock('../storage.ts', () => ({ loadMe: vi.fn(), storeRecord: vi.fn() }))

const user: User = {
  playerId: 'ab'.repeat(32),
  accountId: 'cd'.repeat(32),
  username: 'agile-meerkat-4b8z',
  publicKey: '02' + 'ef'.repeat(32),
  unconfirmed: true,
}

const accountChanged = { account: true, matches: [], revision: 0 }

test('while the store hasn’t read this device’s user, the top bar has no user’s mark', async () => {
  // Any read the store starts stays unanswered for the test.
  let answer!: (loaded: LoadUserResult) => void
  vi.mocked(loadMe).mockReturnValue(new Promise((done) => (answer = done)))
  expect(userStore.getState().user).toEqual({ state: 'unread' })
  const page = new AppLayoutPage()
  const { unmount } = page.render(<h1>A screen</h1>)

  expect(await page.bannerLinks()).toEqual([await page.brand()])
  unmount()
  answer({ ok: true, user: null })
})

test('with storage the browser refuses to read, the top bar has no user’s mark', async () => {
  vi.mocked(loadMe).mockResolvedValue({
    ok: false,
    reason: 'storage-unavailable',
  })
  await userStore.getState().load()
  const page = new AppLayoutPage()
  page.render(<h1>A screen</h1>)

  expect(await page.bannerLinks()).toEqual([await page.brand()])
})

test('with no account yet, the top bar has no user’s mark; once the store reads a user after a change, the mark appears, with no reload and the same brand', async () => {
  vi.mocked(loadMe).mockResolvedValue({ ok: true, user: null })
  await userStore.getState().load()
  const page = new AppLayoutPage()
  page.render(<h1>A screen</h1>)
  const brand = await page.brand()
  expect(await page.bannerLinks()).toEqual([brand])
  vi.mocked(loadMe).mockResolvedValue({ ok: true, user })

  announce(accountChanged)

  expect(await page.userMark('agile-meerkat-4b8z')).toHaveTextContent(/^AM$/)
  expect(await page.brand()).toBe(brand)
})
