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

test('Start match keeps a match with the form’s opponent, length and rating', async () => {
  const user = userEvent.setup()
  renderScreen(<NewMatch />, { path: '/matches/new' })

  await user.type(await page.opponent(), 'Bea')
  await user.click(await page.bestOf(7))
  await user.click(await page.rated())
  await user.click(await page.startMatch())

  await expect.poll(newestMatch).toMatchObject({ opponentName: 'Bea', bestOf: 7, rated: true })
})

test('Start match with no opponent’s name keeps an unrated match with no opponent', async () => {
  const user = userEvent.setup()
  renderScreen(<NewMatch />, { path: '/matches/new' })

  await user.click(await page.startMatch())

  await expect.poll(newestMatch).toMatchObject({
    opponentName: null,
    bestOf: 5,
    rated: false,
  })
})

