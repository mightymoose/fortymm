import userEvent from '@testing-library/user-event'
import { expect, onTestFinished, test, vi } from 'vitest'
import { showNewVersionOf, watchForNewVersion } from '../new-version.ts'
import { matchMemory } from '../stores/match-memory.ts'
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

test('a create the device refused shows why, with the length still chosen; the next Start match that works keeps it and the alert goes', async () => {
  const user = userEvent.setup()
  renderScreen(<NewMatch />, { path: '/matches/new' })
  const before = await newestMatch()
  matchMemory.failNextWrite('storage-unavailable')

  await user.click(await page.bestOf(3))
  await user.click(await page.startMatch())

  expect(await page.alert()).toHaveTextContent(
    'This browser isn’t letting FortyMM store data.',
  )
  expect(await page.bestOf(3)).toBeChecked()
  expect(await newestMatch()).toEqual(before)

  await user.click(await page.startMatch())

  await expect.poll(newestMatch).toMatchObject({ bestOf: 3 })
  expect(page.queryAlert()).toBeNull()
})

test('a create refused for the core, with a new version waiting, offers the new version’s Reload', async () => {
  const user = userEvent.setup()
  const reload = vi.fn()
  showNewVersionOf({ ready: () => true, waiting: () => true, subscribe: () => () => {}, reload, dismiss: () => {} })
  try {
    renderScreen(<NewMatch />, { path: '/matches/new' })
    matchMemory.failNextWrite('core-unavailable')

    await user.click(await page.startMatch())
    await user.click(await page.reload())

    expect(reload).toHaveBeenCalledTimes(1)
  } finally {
    showNewVersionOf({ ready: () => false, waiting: () => false, subscribe: () => () => {}, reload: () => {}, dismiss: () => {} })
  }
})

test('with the update notice dismissed and the new version still waiting, a create refused for the core still offers Reload', async () => {
  const user = userEvent.setup()
  const worker = () =>
    Object.assign(new EventTarget(), { state: 'installed' as const, postMessage: () => {} })
  const registration = Object.assign(new EventTarget(), {
    installing: null,
    waiting: worker(),
    update: async () => {},
  })
  const newVersion = watchForNewVersion(
    registration,
    Object.assign(new EventTarget(), { controller: worker() }),
    () => {},
  )
  onTestFinished(() => newVersion.stop())
  showNewVersionOf(newVersion)
  onTestFinished(() =>
    showNewVersionOf({ ready: () => false, waiting: () => false, subscribe: () => () => {}, reload: () => {}, dismiss: () => {} }),
  )
  newVersion.dismiss()
  renderScreen(<NewMatch />, { path: '/matches/new' })
  matchMemory.failNextWrite('core-unavailable')

  await user.click(await page.startMatch())

  expect(await page.alert()).toHaveTextContent('Plot twist')
  expect(await page.reload()).toBeVisible()
})

