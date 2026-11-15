import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, test } from 'vitest'
import type { Score } from '../scoring/scoring.ts'
import { matchStore } from '../stores/match.ts'
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

// The screen opens a fresh form whenever a game's saved score changes, so
// most saves leave nothing dirty by the time the page moves on. A score
// saved again as it was, typed differently, keeps the same form, still
// dirty: the move on must get past the screen's leave guard.
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
