import userEvent from '@testing-library/user-event'
import { expect, test } from 'vitest'
import { matchesStore } from '../stores/matches.ts'
import { renderScreen } from '../test/render-screen.tsx'
import { NewMatch } from './NewMatch.tsx'
import { NewMatchScreenPage } from './new-match/NewMatchScreen.page.tsx'

// The new match page connected to the app's real match list store (in
// memory, so nothing is replaced): what Start match keeps. It is mounted
// alone, in a bare router with none of the app's routes; where a create
// goes, and that a refused one stays, is the route's test
// (src/routes/matches/new.test.tsx), since this router shows the same page
// at any address, and what the
// form hands its handler, the screen's (new-match/NewMatchScreen.test.tsx).

const page = new NewMatchScreenPage()

async function newestMatch() {
  await matchesStore.getState().load()
  const list = matchesStore.getState().matches
  if (list.status !== 'ready') throw new Error(`list ${list.status}`)
  return list.matches[0]
}

test('Start match keeps a match of the length chosen, unrated, with no opponent’s name', async () => {
  const user = userEvent.setup()
  renderScreen(<NewMatch />, { path: '/matches/new' })

  await user.click(await page.bestOf(7))
  await user.click(await page.startMatch())

  // Exactly these keys: a kept opponent's name would be one more.
  await expect.poll(newestMatch).toEqual({
    matchId: expect.any(String),
    bestOf: 7,
    rated: false,
  })
})

