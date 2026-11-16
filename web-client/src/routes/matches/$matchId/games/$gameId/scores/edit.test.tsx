import userEvent from '@testing-library/user-event'
import { expect, test } from 'vitest'
import { DashboardScreenPage } from '../../../../../../components/DashboardScreen.page.tsx'
import { NotFoundScreenPage } from '../../../../../../components/NotFoundScreen.page.tsx'
import { ScoringScreenPage } from '../../../../../../components/scoring/ScoringScreen.page.tsx'
import { matchStore } from '../../../../../../stores/match.ts'
import { matchMemory } from '../../../../../../stores/match-memory.ts'
import { createMatch } from '../../../../../../test/match.ts'
import { renderRoute } from '../../../../../../test/render-route.tsx'

// The scoring route's wiring: which game a URL opens, as gameToOpen decides
// (src/scoring/game-to-open.test.ts has every case), turned into the screen,
// not found or a redirect; Clear through the real store; and the leave
// guard scoped by the app's real paths (another game of the match asks
// nothing, the dashboard asks). What the screen shows is its own test
// (ScoringScreen.test.tsx); what saving and clearing do to the match, the
// connected component's (src/components/Scoring.test.tsx).

const edit = (matchId: string, game: number | string) =>
  `/matches/${matchId}/games/${game}/scores/edit`

test('a known match’s game shows the scoring screen with the store’s games', async () => {
  const matchId = await createMatch(5, [[11, 7]])
  renderRoute(edit(matchId, 2))
  const page = new ScoringScreenPage()

  expect(await page.heading()).toHaveTextContent('Enter game 2 score.')
  expect(await page.theirs()).toBeVisible()
  expect(page.tally()).toHaveTextContent('Games won: 1 – 0')
})

test.each(['x', '0', '6'])('game %s of a best of 5 is not found', async (game) => {
  const matchId = await createMatch(5)
  renderRoute(edit(matchId, game))

  expect(await new NotFoundScreenPage().heading()).toBeVisible()
})

test('game 3 opens before game 2 is saved, with no redirect', async () => {
  const matchId = await createMatch(5, [[11, 7]])
  const { router } = renderRoute(edit(matchId, 3))

  expect(await new ScoringScreenPage().heading()).toHaveTextContent('Enter game 3 score.')
  expect(router.state.location.pathname).toBe(edit(matchId, 3))
})

test('an unscored game of a decided match redirects to the dashboard, replacing it', async () => {
  const matchId = await createMatch(3, [[11, 1], null, [11, 2]])
  const { router } = renderRoute(edit(matchId, 2))

  expect(await new DashboardScreenPage().heading()).toBeVisible()
  expect(router.state.location.pathname).toBe('/')
  expect(router.history.length).toBe(1)
})

test('Clear on a game’s page empties it and stays there', async () => {
  const user = userEvent.setup()
  const matchId = await createMatch(5, [
    [11, 7],
    [9, 11],
  ])
  const { router } = renderRoute(edit(matchId, 1))
  const page = new ScoringScreenPage()
  expect(await page.heading()).toHaveTextContent('Edit game 1 score.')

  await user.click(page.clear()!)

  expect(await page.heading()).toHaveTextContent('Enter game 1 score.')
  expect(await page.cellLink(2)).toHaveAccessibleName('Game 2, 9–11')
  expect(router.state.location.pathname).toBe(edit(matchId, 1))
})

test('with a score typed and not saved, moving to another game of the match asks nothing', async () => {
  const user = userEvent.setup()
  const matchId = await createMatch(5, [[11, 7]])
  const { router } = renderRoute(edit(matchId, 2))
  const page = new ScoringScreenPage()
  await user.type(await page.yours(), '5')

  await user.click((await page.cellLink(1))!)

  expect(await page.heading()).toHaveTextContent('Edit game 1 score.')
  expect(page.queryLeaveDialog()).toBeNull()
  expect(router.state.location.pathname).toBe(edit(matchId, 1))
})

test('with a score typed and not saved, leaving for the dashboard asks “Leave without saving?”', async () => {
  const user = userEvent.setup()
  const matchId = await createMatch(5, [[11, 7]])
  const { router } = renderRoute(edit(matchId, 2))
  const page = new ScoringScreenPage()
  await user.type(await page.yours(), '5')

  void router.navigate({ to: '/' })

  expect(await page.leaveDialog()).toBeVisible()
  expect(router.state.location.pathname).toBe(edit(matchId, 2))
})

test('with nothing typed, leaving for the dashboard asks nothing', async () => {
  const matchId = await createMatch(5, [[11, 7]])
  const { router } = renderRoute(edit(matchId, 2))
  const page = new ScoringScreenPage()
  await page.heading()

  void router.navigate({ to: '/' })

  expect(await new DashboardScreenPage().heading()).toBeVisible()
  expect(page.queryLeaveDialog()).toBeNull()
})

test('a saved game of a decided match opens for editing', async () => {
  const matchId = await createMatch(3, [
    [11, 1],
    [11, 2],
  ])
  renderRoute(edit(matchId, 1))

  expect(await new ScoringScreenPage().heading()).toHaveTextContent('Edit game 1 score.')
})

// Back from match B's game 1 lands on match A's game 1 (New match replaces
// its form with B's game 1): the same screen at a path that differs only in
// the match.
test('Back from another match’s game, discarding, opens this match’s game fresh: no score typed there, no alert of its own, and Save writes nothing of it here', async () => {
  const user = userEvent.setup()
  const a = await createMatch(5)
  const b = await createMatch(5)
  const { router } = renderRoute(edit(a, 1), { browserHistory: true })
  const page = new ScoringScreenPage()
  await page.heading()
  await router.navigate({ to: edit(b, 1) })
  await expect.poll(() => router.state.location.pathname).toBe(edit(b, 1))
  matchMemory.failNextWrite('storage-unavailable')
  await user.click(await page.yours())
  await user.keyboard('11{Enter}7{Enter}')
  await page.alert()

  router.history.back()
  await user.click(await page.discardAndLeave())
  await expect.poll(() => router.state.location.pathname).toBe(edit(a, 1))

  expect(page.queryAlert()).toBeNull()
  expect(await page.yours()).toHaveValue('')
  expect(await page.theirs()).toHaveValue('')
  await user.click(await page.submit())
  expect(await gamesOf(a)).toEqual([])
})

test('Back from another match’s game with its refusal showing and nothing typed opens this match’s game with no alert', async () => {
  const user = userEvent.setup()
  // The same game 1 saved in both: only the match differs.
  const a = await createMatch(5, [[11, 7]])
  const b = await createMatch(5, [[11, 7]])
  const { router } = renderRoute(edit(a, 1), { browserHistory: true })
  const page = new ScoringScreenPage()
  await page.heading()
  await router.navigate({ to: edit(b, 1) })
  expect(await page.heading()).toHaveTextContent('Edit game 1 score.')
  matchMemory.failNextWrite('storage-unavailable')
  await user.click(page.clear()!)
  await page.alert()

  // Nothing typed: Back asks nothing.
  router.history.back()
  await expect.poll(() => router.state.location.pathname).toBe(edit(a, 1))

  expect(await page.heading()).toHaveTextContent('Edit game 1 score.')
  expect(page.queryAlert()).toBeNull()
})

// The layout's read and this page's are two reads: whichever says the match
// isn't on this device makes the page not found.
test('a match not on this device is not found even when one of its reads is refused', async () => {
  matchMemory.failNextRead('storage-unavailable')
  renderRoute(edit('not-a-match', 1))

  expect(await new NotFoundScreenPage().heading()).toBeVisible()
})

async function gamesOf(matchId: string) {
  const entry = await matchStore.getState().load(matchId)
  if (entry.status !== 'ready') throw new Error(`match ${entry.status}`)
  return entry.match.games
}
