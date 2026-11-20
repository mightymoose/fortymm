import userEvent from '@testing-library/user-event'
import { expect, onTestFinished, test } from 'vitest'
import { matchMemory } from '../test/match-memory.ts'
import { matchesStore } from '../stores/matches.ts'
import { createMatch } from '../test/match.ts'
import { renderScreen } from '../test/render-screen.tsx'
import { MatchList } from './MatchList.tsx'
import { MatchListScreenPage } from './match-list/MatchListScreen.page.tsx'

// The matches list connected to the app's real match list store (in memory,
// so nothing is replaced): it shows what the store reads, and, while
// mounted, a match kept meanwhile with no reload. What the screen shows for
// each list is the screen's test (match-list/MatchListScreen.test.tsx); the
// store's reads, the store's test (src/stores/matches.test.ts).

const page = new MatchListScreenPage()

// First in the file: the app's one store has no matches yet. The loader's
// read (src/routes/matches/index.tsx) is done here by hand.
test('with no matches kept, the empty state shows; a match kept while the page is open then shows as its row', async () => {
  await matchesStore.getState().load()
  renderScreen(<MatchList />, { path: '/matches' })

  expect(await page.emptyState()).toBeVisible()

  // Kept with game 1 saved: the save is a write the list hears of only by
  // watching (a create alone reads the list again by itself).
  const matchId = await createMatch(3, [[11, 5]])

  const [row] = await page.rows()
  expect(page.cells(row!)).toEqual(['You vs Anonymous', 'Best of 3 · Unrated'])
  expect(page.matchLink(row!)).toHaveAttribute('href', `/matches/${matchId}`)
  expect(page.emptyStateNow()).toBeNull()
})

test('a list the device wouldn’t read says so, not the pending view; Try again, once it reads, shows the list', async () => {
  const user = userEvent.setup()
  const readable = matchMemory.failReads('storage-unavailable')
  onTestFinished(readable)
  await matchesStore.getState().load()
  renderScreen(<MatchList />, { path: '/matches' })

  expect(await page.unavailable()).toBeVisible()
  // The read the page's watch starts with, refused too.
  await new Promise((settled) => setTimeout(settled))
  expect(page.unavailableNow()).not.toBeNull()
  readable()

  await user.click(await page.tryAgain())

  expect(await page.table()).toBeVisible()
  expect(page.unavailableNow()).toBeNull()
})
