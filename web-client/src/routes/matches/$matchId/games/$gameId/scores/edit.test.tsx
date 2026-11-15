import { expect, test } from 'vitest'
import { DashboardScreenPage } from '../../../../../../components/DashboardScreen.page.tsx'
import { NotFoundScreenPage } from '../../../../../../components/NotFoundScreen.page.tsx'
import { ScoringScreenPage } from '../../../../../../components/scoring/ScoringScreen.page.tsx'
import { createMatch } from '../../../../../../test/match.ts'
import { renderRoute } from '../../../../../../test/render-route.tsx'

// The scoring route's wiring: which game a URL opens, as gameToOpen decides
// (src/scoring/game-to-open.test.ts has every case), turned into the screen,
// not found or a redirect. What the screen shows is its own test
// (ScoringScreen.test.tsx); what saving and clearing do, the connected
// component's (src/components/Scoring.test.tsx).

const edit = (matchId: string, game: number | string) =>
  `/matches/${matchId}/games/${game}/scores/edit`

test('a known match’s game shows the scoring screen with the store’s games', async () => {
  const matchId = await createMatch(5, [[11, 7]])
  renderRoute(edit(matchId, 2))
  const page = new ScoringScreenPage()

  expect(await page.heading()).toHaveTextContent('Enter game 2 score.')
  expect(await page.theirs('Ana')).toBeVisible()
  expect(page.tally()).toHaveTextContent('Games won: 1 – 0')
})

test.each(['x', '0', '6'])('game %s of a best of 5 is not found', async (game) => {
  const matchId = await createMatch(5)
  renderRoute(edit(matchId, game))

  expect(await new NotFoundScreenPage().heading()).toBeVisible()
})

test('a game past the first unscored game redirects to the first unscored game, replacing it', async () => {
  const matchId = await createMatch(5, [[11, 7]])
  const { router } = renderRoute(edit(matchId, 4))

  expect(await new ScoringScreenPage().heading()).toHaveTextContent('Enter game 2 score.')
  expect(router.state.location.pathname).toBe(edit(matchId, 2))
  expect(router.history.length).toBe(1)
})

test('an unscored game of a decided match redirects to the dashboard', async () => {
  const matchId = await createMatch(3, [
    [11, 1],
    [11, 2],
  ])
  const { router } = renderRoute(edit(matchId, 3))

  expect(await new DashboardScreenPage().heading()).toBeVisible()
  expect(router.state.location.pathname).toBe('/')
})

test('a saved game of a decided match opens for editing', async () => {
  const matchId = await createMatch(3, [
    [11, 1],
    [11, 2],
  ])
  renderRoute(edit(matchId, 1))

  expect(await new ScoringScreenPage().heading()).toHaveTextContent('Edit game 1 score.')
})
