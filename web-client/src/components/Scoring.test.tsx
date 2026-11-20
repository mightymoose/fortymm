import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, onTestFinished, test, vi } from 'vitest'
import type { Games, Score } from '../scoring/scoring.ts'
import { matchStore } from '../stores/match.ts'
import { matchMemory } from '../test/match-memory.ts'
import { createMatch } from '../test/match.ts'
import { Scoring } from './Scoring.tsx'
import { ScoringScreenPage } from './scoring/ScoringScreen.page.tsx'

// The scoring page connected to the app's real match store (in memory, so
// nothing is replaced): what its save and clear do to the match and where
// they go. It is mounted in a bare router of its own, with a route at the
// scoring page's path and one at `/`, and none of the app's routes or
// loaders: which game a URL may open is the route's test
// (src/routes/matches/$matchId/games/$gameId/scores/edit.test.tsx); what the
// screen shows, the screen's (scoring/ScoringScreen.test.tsx).

async function renderScoring(matchId: string, game: number) {
  await matchStore.getState().load(matchId)
  const rootRoute = createRootRoute()
  const scoring = createRoute({
    getParentRoute: () => rootRoute,
    path: '/matches/$matchId/games/$gameId/scores/edit',
    component: function ScoringAt() {
      const params = scoring.useParams()
      return <Scoring matchId={params.matchId} game={Number(params.gameId)} />
    },
  })
  const dashboard = createRoute({
    getParentRoute: () => rootRoute,
    path: '/',
    component: () => <h1>Dashboard</h1>,
  })
  const router = createRouter({
    routeTree: rootRoute.addChildren([scoring, dashboard]),
    history: createMemoryHistory({ initialEntries: ['/', edit(matchId, game)] }),
  })
  render(<RouterProvider router={router} />)
  return router
}

const edit = (matchId: string, game: number) => `/matches/${matchId}/games/${game}/scores/edit`

async function gamesOf(matchId: string) {
  const entry = await matchStore.getState().load(matchId)
  if (entry.status !== 'ready') throw new Error(`match ${entry.status}`)
  return entry.match.games
}

const page = new ScoringScreenPage()

test('saving a game that doesn’t decide the match saves it and opens the first unscored game in its place, asking nothing', async () => {
  const user = userEvent.setup()
  const matchId = await createMatch(5)
  const router = await renderScoring(matchId, 1)
  expect(await page.heading()).toHaveTextContent('Enter game 1 score.')

  await user.keyboard('11{Enter}7{Enter}')

  expect(await page.heading()).toHaveTextContent('Enter game 2 score.')
  expect(router.state.location.pathname).toBe(edit(matchId, 2))
  expect(router.history.length).toBe(2)
  expect(page.queryLeaveDialog()).toBeNull()
  expect(await gamesOf(matchId)).toEqual([[11, 7]])
})

test('saving the deciding game goes to the dashboard, asking nothing', async () => {
  const user = userEvent.setup()
  const matchId = await createMatch(3, [[11, 7]])
  const router = await renderScoring(matchId, 2)
  await page.heading()

  await user.keyboard('11{Enter}9{Enter}')

  expect(await screen.findByRole('heading', { name: 'Dashboard' })).toBeVisible()
  expect(router.state.location.pathname).toBe('/')
  expect(page.queryLeaveDialog()).toBeNull()
  expect(await gamesOf(matchId)).toEqual([
    [11, 7],
    [11, 9],
  ])
})

test('editing an earlier game saves it and opens the first unscored game', async () => {
  const user = userEvent.setup()
  const games: Score[] = [
    [11, 7],
    [9, 11],
  ]
  const matchId = await createMatch(5, games)
  const router = await renderScoring(matchId, 1)
  expect(await page.heading()).toHaveTextContent('Edit game 1 score.')

  await user.keyboard('11{Enter}9{Enter}')

  expect(await page.heading()).toHaveTextContent('Enter game 3 score.')
  expect(router.state.location.pathname).toBe(edit(matchId, 3))
  expect(page.queryLeaveDialog()).toBeNull()
  expect(await gamesOf(matchId)).toEqual([
    [11, 9],
    [9, 11],
  ])
})

test('editing a game of a decided match, leaving it decided, goes to the dashboard', async () => {
  const user = userEvent.setup()
  const matchId = await createMatch(3, [
    [11, 7],
    [11, 5],
  ])
  const router = await renderScoring(matchId, 1)
  await page.heading()

  await user.keyboard('11{Enter}9{Enter}')

  expect(await screen.findByRole('heading', { name: 'Dashboard' })).toBeVisible()
  expect(router.state.location.pathname).toBe('/')
  expect(await gamesOf(matchId)).toEqual([
    [11, 9],
    [11, 5],
  ])
})

test('saving a game scored out of order opens the lowest empty game', async () => {
  const user = userEvent.setup()
  const matchId = await createMatch(5, [[11, 7]])
  const router = await renderScoring(matchId, 3)
  expect(await page.heading()).toHaveTextContent('Enter game 3 score.')

  await user.keyboard('11{Enter}4{Enter}')

  expect(await page.heading()).toHaveTextContent('Enter game 2 score.')
  expect(router.state.location.pathname).toBe(edit(matchId, 2))
  expect(await gamesOf(matchId)).toEqual([[11, 7], null, [11, 4]])
})

test('clearing a game below the highest empties it at once and stays on its page, its fields empty', async () => {
  const user = userEvent.setup()
  const matchId = await createMatch(5, [
    [11, 7],
    [9, 11],
    [11, 4],
  ])
  const router = await renderScoring(matchId, 1)
  expect(await page.heading()).toHaveTextContent('Edit game 1 score.')

  await user.click(page.clear()!)

  expect(await page.heading()).toHaveTextContent('Enter game 1 score.')
  expect(await page.yours()).toHaveValue('')
  expect(router.state.location.pathname).toBe(edit(matchId, 1))
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(await gamesOf(matchId)).toEqual([null, [9, 11], [11, 4]])
})

// A saved form is still dirty when the page moves on (the same form takes a
// new kept score in place), and so is a score saved again as it was, typed
// differently: the move on must get past the screen's leave guard.
test('saving a game’s score again as it was, typed differently, moves on asking nothing', async () => {
  const user = userEvent.setup()
  const matchId = await createMatch(5, [[11, 7]])
  const router = await renderScoring(matchId, 1)
  await page.heading()

  await user.keyboard('11{Enter}07{Enter}')

  expect(await page.heading()).toHaveTextContent('Enter game 2 score.')
  expect(router.state.location.pathname).toBe(edit(matchId, 2))
  expect(page.queryLeaveDialog()).toBeNull()
  expect(await gamesOf(matchId)).toEqual([[11, 7]])
})

test('a save the device refused stays on the game with the typed score and says so; the next save that works moves on', async () => {
  const user = userEvent.setup()
  const matchId = await createMatch(5)
  const router = await renderScoring(matchId, 1)
  await page.heading()
  matchMemory.failNextWrite('storage-unavailable')

  await user.keyboard('11{Enter}07{Enter}')

  expect(await page.alert()).toHaveTextContent('Check that your browser allows site data and that you have free storage space, then try again.')
  expect(await page.yours()).toHaveValue('11')
  expect(await page.theirs()).toHaveValue('07')
  expect(router.state.location.pathname).toBe(edit(matchId, 1))
  expect(await gamesOf(matchId)).toEqual([])

  await user.click(await page.submit())

  expect(await page.heading()).toHaveTextContent('Enter game 2 score.')
  expect(page.queryAlert()).toBeNull()
  expect(await gamesOf(matchId)).toEqual([[11, 7]])
})

// A move to another game while a save is on its way waits for its answer
// (the user's choice, 2026-11-16).
test('a tap on another game while a save is on its way, which the device then refuses, is dropped: the game stays with its typed score and the alert', async () => {
  const user = userEvent.setup()
  const matchId = await createMatch(5)
  const router = await renderScoring(matchId, 1)
  await page.heading()
  const release = matchMemory.holdNextWrite()
  matchMemory.failNextWrite('storage-unavailable')
  await user.keyboard('11{Enter}07{Enter}')

  await user.click((await page.cellLink(3))!)
  release()

  expect(await page.alert()).toBeVisible()
  expect(await page.heading()).toHaveTextContent('Enter game 1 score.')
  expect(await page.yours()).toHaveValue('11')
  expect(await page.theirs()).toHaveValue('07')
  expect(router.state.location.pathname).toBe(edit(matchId, 1))
  expect(page.queryLeaveDialog()).toBeNull()
})

test('a tap on another game while a save is on its way, which then works, moves on as a save does', async () => {
  const user = userEvent.setup()
  const matchId = await createMatch(5)
  const router = await renderScoring(matchId, 1)
  await page.heading()
  const release = matchMemory.holdNextWrite()
  await user.keyboard('11{Enter}07{Enter}')

  await user.click((await page.cellLink(3))!)
  release()

  await expect.poll(() => router.state.location.pathname).toBe(edit(matchId, 2))
  expect(await page.heading()).toHaveTextContent('Enter game 2 score.')
  expect(page.queryLeaveDialog()).toBeNull()
  expect(await gamesOf(matchId)).toEqual([[11, 7]])
})

// A correction's "next game" is another game: a refusal must not move on.
test('a correction of a saved game the device refused stays on that game with the typed score and says so', async () => {
  const user = userEvent.setup()
  const matchId = await createMatch(5, [[11, 7]])
  const router = await renderScoring(matchId, 1)
  expect(await page.heading()).toHaveTextContent('Edit game 1 score.')
  matchMemory.failNextWrite('storage-unavailable')

  await user.keyboard('11{Enter}9{Enter}')

  expect(await page.alert()).toBeVisible()
  expect(router.state.location.pathname).toBe(edit(matchId, 1))
  expect(await page.yours()).toHaveValue('11')
  expect(await page.theirs()).toHaveValue('9')
  expect(await gamesOf(matchId)).toEqual([[11, 7]])
})

test('a clear the device refused keeps the game saved and says so; the next clear that works empties it and the alert goes', async () => {
  const user = userEvent.setup()
  const matchId = await createMatch(5, [[11, 7]])
  await renderScoring(matchId, 1)
  await page.heading()
  matchMemory.failNextWrite('core-unavailable')

  await user.click(page.clear()!)

  expect(await page.alert()).toHaveTextContent('Your saved score is still 11–7. Part of FortyMM didn’t load. Try clearing it again.')
  expect(await page.yours()).toHaveValue('11')
  expect(await gamesOf(matchId)).toEqual([[11, 7]])

  await user.click(page.clear()!)

  expect(await page.heading()).toHaveTextContent('Enter game 1 score.')
  expect(page.queryAlert()).toBeNull()
})

// Another tab's write reaches a watched match through the source's change
// (here, a write straight to the memory). The page shows it at once, and
// says so (the user's rule: "we can change things in the background as long
// as theres some notification that it happened").
async function savedElsewhere(matchId: string, game: number, score: Score | null) {
  const saved = await matchMemory.saveGame(matchId, game, () => ({ score }))
  if (!saved.ok) throw new Error(`game ${game} not saved elsewhere`)
}

// Waits until the store has read the match again after another tab's write.
async function readAgain(matchId: string, games: Games) {
  await vi.waitFor(() =>
    expect(matchStore.getState().matches[matchId]).toEqual({
      status: 'ready',
      match: expect.objectContaining({ games }),
    }),
  )
}

// R1
test('another tab changing another game shows on the page at once: its scoreline cell, the tally, and “Game 1 updated.”; what is typed stays', async () => {
  const user = userEvent.setup()
  const matchId = await createMatch(5, [[11, 7]])
  const stop = matchStore.getState().watchMatch(matchId)
  await renderScoring(matchId, 2)
  await page.heading()
  await user.keyboard('11{Enter}5')

  await savedElsewhere(matchId, 1, [7, 11])
  await readAgain(matchId, [[7, 11]])

  await vi.waitFor(async () => expect(await page.cell(1)).toHaveTextContent('7–11'))
  expect(page.tally()).toHaveTextContent('0 – 1')
  expect(await page.updated()).toHaveTextContent(/^Game 1 updated\.$/)
  expect(await page.heading()).toHaveTextContent('Enter game 2 score.')
  expect(await page.yours()).toHaveValue('11')
  expect(await page.theirs()).toHaveValue('5')
  expect(await page.theirs()).toHaveFocus()
  stop()
})

// R2: the fields are the same elements, so focus (and a phone's keyboard)
// stays where it was.
test.each([
  {
    name: 'a saved game corrected',
    games: [[11, 7]] as Games,
    game: 1,
    elsewhere: [9, 11] as Score,
    heading: 'Edit game 1 score.',
  },
  {
    name: 'an empty game saved',
    games: [[11, 7]] as Games,
    game: 2,
    elsewhere: [11, 8] as Score,
    heading: 'Edit game 2 score.',
  },
])(
  '$name elsewhere, its fields untouched: they show the new score in place, focus stays, and it is read out',
  async ({ games, game, elsewhere, heading }) => {
    const user = userEvent.setup()
    const matchId = await createMatch(5, games)
    const stop = matchStore.getState().watchMatch(matchId)
    await renderScoring(matchId, game)
    await page.heading()
    const theirs = await page.theirs()
    await user.click(theirs)

    await savedElsewhere(matchId, game, elsewhere)

    await vi.waitFor(async () => expect(await page.yours()).toHaveValue(String(elsewhere[0])))
    expect(await page.theirs()).toHaveValue(String(elsewhere[1]))
    expect(await page.theirs()).toBe(theirs)
    expect(theirs).toHaveFocus()
    expect(await page.heading()).toHaveTextContent(heading)
    expect(page.clear()).not.toBeNull()
    expect(await page.updated()).toHaveTextContent(`Game ${game} updated.`)
    stop()
  },
)

// R3: approved default 1 (2026-11-18), and Save always overwrites (default
// 3).
test('this game changed elsewhere after one field was typed in: both fields keep what is typed, and Save keeps that', async () => {
  const user = userEvent.setup()
  const matchId = await createMatch(5, [[11, 7]])
  const stop = matchStore.getState().watchMatch(matchId)
  const router = await renderScoring(matchId, 1)
  await page.heading()
  await user.click(await page.theirs())
  await user.keyboard('9')

  await savedElsewhere(matchId, 1, [3, 11])
  await readAgain(matchId, [[3, 11]])

  expect(await page.updated()).toHaveTextContent('Game 1 updated.')
  expect(await page.cell(1)).toHaveTextContent('3–11')
  expect(await page.yours()).toHaveValue('11')
  expect(await page.theirs()).toHaveValue('9')
  await user.click(await page.submit())
  await vi.waitFor(() => expect(router.state.location.pathname).toBe(edit(matchId, 2)))
  expect(await gamesOf(matchId)).toEqual([[11, 9]])
  stop()
})

// R4: the store holds what this page wrote a moment before the write
// answers; that is no change to tell, even for that moment.
test('this page’s own clear and save read out nothing, not even for a moment', async () => {
  const user = userEvent.setup()
  const matchId = await createMatch(5, [[11, 7]])
  const stop = matchStore.getState().watchMatch(matchId)
  await renderScoring(matchId, 1)
  await page.heading()
  const told: string[] = []
  const observer = new MutationObserver(() =>
    told.push(
      document.querySelector('nav[aria-label="Scoreline"] [role="status"]')?.textContent ?? '',
    ),
  )
  observer.observe(document.body, { childList: true, subtree: true, characterData: true })

  await user.click(page.clear()!)
  expect(await page.heading()).toHaveTextContent('Enter game 1 score.')
  await user.keyboard('11{Enter}3{Enter}')
  expect(await page.heading()).toHaveTextContent('Enter game 2 score.')
  expect(await gamesOf(matchId)).toEqual([[11, 3]])

  observer.disconnect()
  expect(told.filter((text) => text !== '')).toEqual([])
  expect(await page.updated()).toBeEmptyDOMElement()
  stop()
})

// R5 (bug 1 of the second review): the page's memory of its own save ends
// with the save, not with the page.
test('back on a game this page saved, another tab correcting it shows: the new score, read out', async () => {
  const user = userEvent.setup()
  const matchId = await createMatch(5)
  const stop = matchStore.getState().watchMatch(matchId)
  await renderScoring(matchId, 1)
  await page.heading()
  await user.keyboard('11{Enter}5{Enter}')
  expect(await page.heading()).toHaveTextContent('Enter game 2 score.')
  await user.click((await page.cellLink(1))!)
  expect(await page.heading()).toHaveTextContent('Edit game 1 score.')

  await savedElsewhere(matchId, 1, [3, 11])

  await vi.waitFor(async () => expect(await page.yours()).toHaveValue('3'))
  expect(await page.theirs()).toHaveValue('11')
  expect(await page.updated()).toHaveTextContent('Game 1 updated.')
  stop()
})

// R6: approved default 2: the notice only for an empty game.
test('the match decided elsewhere while this empty game’s page is open: the finished notice, Save off, a link to the match, and what is typed stays', async () => {
  const user = userEvent.setup()
  const matchId = await createMatch(3, [[11, 5]])
  const stop = matchStore.getState().watchMatch(matchId)
  const router = await renderScoring(matchId, 3)
  await page.heading()
  await user.keyboard('11{Enter}9')

  await savedElsewhere(matchId, 2, [11, 4])

  expect(await page.finished()).toBeInTheDocument()
  expect(await page.submit()).toBeDisabled()
  expect(await page.goToMatch()).toHaveAttribute('href', `/matches/${matchId}`)
  expect(await page.yours()).toHaveValue('11')
  expect(await page.theirs()).toHaveValue('9')
  await user.keyboard('{Enter}')
  expect(router.state.location.pathname).toBe(edit(matchId, 3))
  expect(await gamesOf(matchId)).toEqual([[11, 5], [11, 4]])
  stop()
})

test('a game with a score, in a match decided elsewhere, shows no finished notice and can still be corrected', async () => {
  const user = userEvent.setup()
  const matchId = await createMatch(3, [[11, 5]])
  const stop = matchStore.getState().watchMatch(matchId)
  const router = await renderScoring(matchId, 1)
  await page.heading()

  await savedElsewhere(matchId, 2, [11, 4])
  await readAgain(matchId, [[11, 5], [11, 4]])
  expect(await page.updated()).toHaveTextContent('Game 2 updated.')
  expect(page.queryFinished()).toBeNull()
  await user.click(await page.theirs())
  await user.keyboard('9{Enter}')

  await vi.waitFor(() => expect(router.state.location.pathname).toBe('/'))
  expect(await gamesOf(matchId)).toEqual([[11, 9], [11, 4]])
  stop()
})

// R7 (bug 2 of the second review): the page never renders nothing.
test('a page whose first read was refused, readable again once another tab decided the match, shows the finished notice for its empty game', async () => {
  const matchId = await createMatch(3, [[11, 5]])
  const allowReads = matchMemory.failReads('storage-unavailable')
  onTestFinished(allowReads)
  // The page's loaders read first; its layout watches once it is drawn.
  await renderScoring(matchId, 3)
  const stop = matchStore.getState().watchMatch(matchId)
  expect(matchStore.getState().matches[matchId]?.status).toBe('unavailable')
  allowReads()

  await savedElsewhere(matchId, 2, [11, 4])
  await readAgain(matchId, [[11, 5], [11, 4]])

  expect(await page.finished()).toBeInTheDocument()
  expect(await page.heading()).toHaveTextContent('Enter game 3 score.')
  expect(await page.submit()).toBeDisabled()
  stop()
})

// R8: one polite read-out per change, its words replaced, never added to.
test('each change elsewhere is read out once, politely, in the scoreline’s status: the latest replaces the one before', async () => {
  const matchId = await createMatch(5, [[11, 7]])
  const stop = matchStore.getState().watchMatch(matchId)
  await renderScoring(matchId, 2)
  await page.heading()

  await savedElsewhere(matchId, 1, [7, 11])
  await vi.waitFor(async () => expect(await page.updated()).toHaveTextContent(/^Game 1 updated\.$/))
  await savedElsewhere(matchId, 3, [11, 2])
  await vi.waitFor(async () => expect(await page.updated()).toHaveTextContent(/^Game 3 updated\.$/))

  expect(screen.getAllByRole('status').filter((region) => /updated/.test(region.textContent ?? ''))).toHaveLength(1)
  stop()
})

// Round 4 (interrogate-g2c). Lets everything run that can without the
// held write.
const settle = () => new Promise((resolve) => setTimeout(resolve))

// The match watched, as the match layout (Match.tsx) watches it while
// scoring is open: unwatched, a save's own change drops the store's entry
// for a moment, and the page is drawn afresh, which the app never does.
function watched(matchId: string) {
  onTestFinished(matchStore.getState().watchMatch(matchId))
}

// Bug 1: leaving while a save is on its way waits for its answer, as a move
// to another game does, and asks nothing: the score is being kept, so
// "Leaving now discards it" would be untrue. Once it answers, the person is
// where they went, and nothing pulls them back.
test.each([
  { name: 'a new score', games: [] as Games, keys: '11{Enter}4{Enter}', kept: [[11, 4]] as Games },
  { name: 'a saved score, unchanged', games: [[11, 7]] as Games, keys: '{Enter}{Enter}', kept: [[11, 7]] as Games },
])(
  'leaving while a save of $name is on its way waits for it, asking nothing, then stays where the person went',
  async ({ games, keys, kept }) => {
    const user = userEvent.setup()
    const matchId = await createMatch(5, games)
    watched(matchId)
    const router = await renderScoring(matchId, 1)
    await page.heading()
    const release = matchMemory.holdNextWrite()
    onTestFinished(release)
    await user.keyboard(keys)

    void router.navigate({ to: '/' })
    await settle()
    expect(page.queryLeaveDialog()).toBeNull()
    release()

    expect(await screen.findByRole('heading', { name: 'Dashboard' })).toBeVisible()
    await settle()
    expect(router.state.location.pathname).toBe('/')
    expect(page.queryLeaveDialog()).toBeNull()
    expect(await gamesOf(matchId)).toEqual(kept)
    // Nothing moved on in between: Back is the game they left.
    router.history.back()
    await vi.waitFor(() => expect(router.state.location.pathname).toBe(edit(matchId, 1)))
  },
)

test('leaving while a save is on its way, which the device then refuses, stays on the game with its typed score and the alert, asking nothing', async () => {
  const user = userEvent.setup()
  const matchId = await createMatch(5)
  watched(matchId)
  const router = await renderScoring(matchId, 1)
  await page.heading()
  const release = matchMemory.holdNextWrite()
  onTestFinished(release)
  matchMemory.failNextWrite('storage-unavailable')
  await user.keyboard('11{Enter}4{Enter}')

  void router.navigate({ to: '/' })
  await settle()
  release()

  expect(await page.alert()).toBeVisible()
  expect(router.state.location.pathname).toBe(edit(matchId, 1))
  expect(await page.yours()).toHaveValue('11')
  expect(await page.theirs()).toHaveValue('4')
  expect(page.queryLeaveDialog()).toBeNull()
})

// Bug 3: the user's decision (2026-11-20), "the clear should continue in
// the background".
test('a tap on another game while a clear is on its way opens it at once; the clear is kept, and isn’t read out as a change made elsewhere', async () => {
  const user = userEvent.setup()
  const matchId = await createMatch(5, [[11, 7], [9, 11]])
  const stop = matchStore.getState().watchMatch(matchId)
  const router = await renderScoring(matchId, 1)
  await page.heading()
  const release = matchMemory.holdNextWrite()
  onTestFinished(release)

  await user.click(page.clear()!)
  await user.click((await page.cellLink(2))!)

  expect(await page.heading()).toHaveTextContent('Edit game 2 score.')
  expect(router.state.location.pathname).toBe(edit(matchId, 2))
  release()
  await readAgain(matchId, [null, [9, 11]])
  await vi.waitFor(async () => expect(await page.cellLink(1)).toHaveAccessibleName('Game 1, not yet played'))
  expect(await page.updated()).toBeEmptyDOMElement()
  expect(await page.heading()).toHaveTextContent('Edit game 2 score.')
  stop()
})

test('a clear the device refuses after the person moved to another game says so on that game’s page', async () => {
  const user = userEvent.setup()
  const matchId = await createMatch(5, [[11, 7], [9, 11]])
  watched(matchId)
  const router = await renderScoring(matchId, 1)
  await page.heading()
  const release = matchMemory.holdNextWrite()
  onTestFinished(release)
  matchMemory.failNextWrite('storage-unavailable')

  await user.click(page.clear()!)
  await user.click((await page.cellLink(2))!)
  expect(await page.heading()).toHaveTextContent('Edit game 2 score.')
  release()

  const alert = await page.alert()
  expect(alert).toHaveAccessibleName('Couldn’t clear game 1’s score')
  expect(alert).toHaveTextContent(
    'Couldn’t clear game 1’s scoreGame 1 is still saved as 11–7. Check that your browser allows site data and that you have free storage space, then try again.',
  )
  expect(router.state.location.pathname).toBe(edit(matchId, 2))
  expect(await gamesOf(matchId)).toEqual([[11, 7], [9, 11]])
})

// A clear's refusal could show nowhere once scoring is left: leaving waits
// for it, as for a save.
test('leaving while a clear is on its way waits for it, asking nothing, then goes', async () => {
  const user = userEvent.setup()
  const matchId = await createMatch(5, [[11, 7]])
  watched(matchId)
  const router = await renderScoring(matchId, 1)
  await page.heading()
  const release = matchMemory.holdNextWrite()
  onTestFinished(release)

  await user.click(page.clear()!)
  void router.navigate({ to: '/' })
  await settle()
  expect(router.state.location.pathname).toBe(edit(matchId, 1))
  release()

  expect(await screen.findByRole('heading', { name: 'Dashboard' })).toBeVisible()
  expect(page.queryLeaveDialog()).toBeNull()
  expect(await gamesOf(matchId)).toEqual([])
})

// Bug 4: whether leaving asks is measured against the score kept now, not
// the one the page opened with.
test.each([
  { name: 'cleared elsewhere, so the typed score is no longer kept: leaving asks', typed: '5', elsewhere: null, asks: true },
  { name: 'saved elsewhere as the typed score: leaving asks nothing', typed: '3', elsewhere: [11, 3] as Score, asks: false },
])('a score typed on a saved game, $name', async ({ typed, elsewhere, asks }) => {
  const user = userEvent.setup()
  const matchId = await createMatch(5, [[11, 5]])
  const stop = matchStore.getState().watchMatch(matchId)
  const router = await renderScoring(matchId, 1)
  await page.heading()
  await user.click(await page.theirs())
  await user.keyboard(`9{Backspace}${typed}`)

  await savedElsewhere(matchId, 1, elsewhere)
  await readAgain(matchId, elsewhere === null ? [] : [elsewhere])
  void router.navigate({ to: '/' })

  if (asks) {
    expect(await page.leaveDialog()).toBeVisible()
    expect(router.state.location.pathname).toBe(edit(matchId, 1))
  } else {
    expect(await screen.findByRole('heading', { name: 'Dashboard' })).toBeVisible()
    expect(page.queryLeaveDialog()).toBeNull()
  }
  stop()
})

// Bug 6: a refusal of the typed score is checked again when the games
// change, as it is when the score is typed.
test('a refused score that another tab’s change makes legal loses its error', async () => {
  const user = userEvent.setup()
  const matchId = await createMatch(3, [[11, 1], null, [11, 3]])
  const stop = matchStore.getState().watchMatch(matchId)
  await renderScoring(matchId, 2)
  await page.heading()
  await user.keyboard('11{Enter}5{Enter}')
  await vi.waitFor(() =>
    expect(page.error()).toHaveTextContent(
      "With this score the match is decided in game 2, so game 3 can't have been played.",
    ),
  )

  await savedElsewhere(matchId, 3, null)
  await readAgain(matchId, [[11, 1]])

  await vi.waitFor(async () => expect(await page.submit()).toHaveTextContent('Finish match'))
  expect(page.error()).toBeNull()
  stop()
})
