import { expect, test, vi } from 'vitest'
import { loadMe, type User } from '../storage.ts'
import { userStore } from '../stores/user.ts'
import { renderScreen } from '../test/render-screen.tsx'
import { NewMatch } from './NewMatch.tsx'
import { NewMatchScreenPage } from './NewMatchScreen.page.tsx'

// The new match page connected to the real user store (src/stores/user.ts):
// the card's You is whatever the store reads. Only the storage the store
// reads is replaced (loadMe; jsdom has no IndexedDB). What the screen shows
// for a user and for none is the screen's test (NewMatchScreen.test.tsx).
vi.mock('../storage.ts', () => ({ loadMe: vi.fn(), storeRecord: vi.fn() }))

const user: User = {
  playerId: 'ab'.repeat(32),
  accountId: 'cd'.repeat(32),
  username: 'brisk-otter-0042',
  publicKey: '02' + 'ef'.repeat(32),
  unconfirmed: true,
}

test('the card’s You is this device’s username, as the user store reads it', async () => {
  vi.mocked(loadMe).mockResolvedValue({ ok: true, user })
  await userStore.getState().load()

  renderScreen(<NewMatch />, { path: '/matches/new' })

  expect(await new NewMatchScreenPage().you()).toHaveTextContent(
    'brisk-otter-0042',
  )
})
