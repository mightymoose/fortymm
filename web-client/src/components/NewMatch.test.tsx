import userEvent from '@testing-library/user-event'
import { expect, test } from 'vitest'
import { myMatchesStore } from '../stores/my-matches.ts'
import { renderScreen } from '../test/render-screen.tsx'
import { NewMatch } from './NewMatch.tsx'
import { NewMatchScreenPage } from './new-match/NewMatchScreen.page.tsx'

// The new match page connected to the app's real match list store (in
// memory, so nothing is replaced): what Start match keeps. It is mounted
// alone, in a bare router with none of the app's routes; where a create
// goes is the route's test (src/routes/matches/new.test.tsx), and what the
// form hands its handler, the screen's (new-match/NewMatchScreen.test.tsx).

const page = new NewMatchScreenPage()

async function newestMatch() {
  await myMatchesStore.getState().load()
  const list = myMatchesStore.getState().myMatches
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

// Only the device's storage can refuse a create, and the matches are in
// memory until it exists: the store's action is replaced for this one test.
test('a create the store refuses stays on the form, as filled, asking nothing', async () => {
  const user = userEvent.setup()
  const { createMatch } = myMatchesStore.getState()
  let refused = false
  myMatchesStore.setState({
    createMatch: async () => {
      refused = true
      return { ok: false, reason: 'storage-unavailable' }
    },
  })
  try {
    renderScreen(<NewMatch />, { path: '/matches/new' })
    await user.type(await page.opponent(), 'Cy')
    await user.click(await page.startMatch())

    await expect.poll(() => refused).toBe(true)
    // Past the answer: a navigation would have left this bare router's one
    // page for its empty not-found.
    await new Promise((settled) => setTimeout(settled, 0))
    expect(await page.heading()).toBeVisible()
    expect(await page.opponent()).toHaveValue('Cy')
    expect(page.queryDiscardDialog()).toBeNull()
  } finally {
    myMatchesStore.setState({ createMatch })
  }
})
