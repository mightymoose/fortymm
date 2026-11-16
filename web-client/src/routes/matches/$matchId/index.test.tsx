import userEvent from '@testing-library/user-event'
import { screen, within } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { AppLayoutPage } from '../../../components/AppLayout.page.tsx'
import { MatchDetailsScreenPage } from '../../../components/match-details/MatchDetailsScreen.page.tsx'
import { MatchListScreenPage } from '../../../components/match-list/MatchListScreen.page.tsx'
import { NotFoundScreenPage } from '../../../components/NotFoundScreen.page.tsx'
import { ScoringScreenPage } from '../../../components/scoring/ScoringScreen.page.tsx'
import { createMatch } from '../../../test/match.ts'
import { renderRoute } from '../../../test/render-route.tsx'

// The route's wiring: a known match's details page, under the match layout
// ($matchId.tsx, which reads the match or gives not found), Score reaching
// the scoring route, and the way back. What the screen shows in each state
// is its own test (src/components/match-details/MatchDetailsScreen.test.tsx);
// that it follows the store, the connected component's (MatchDetails.test.tsx).
test('a known match’s /matches/<id> shows its details page with the store’s match, in the layout’s one main landmark, through the match layout', async () => {
  const matchId = await createMatch(5, [[11, 7], [9, 11], [11, 5]])
  const { router } = renderRoute(`/matches/${matchId}`)
  const page = new MatchDetailsScreenPage()

  const heading = await page.heading()
  expect(heading).toHaveTextContent('You vs Anonymous')
  expect(await page.format()).toHaveTextContent('Best of 5 · Unrated · Game 4 next')
  expect(await page.tally()).toHaveTextContent('2 – 1')
  const main = await new AppLayoutPage().main()
  expect(screen.getAllByRole('main')).toEqual([main])
  expect(within(main).getByRole('heading', { level: 1 })).toBe(heading)
  expect(router.state.matches.map((match) => match.routeId)).toEqual([
    '__root__',
    '/matches',
    '/matches/$matchId',
    '/matches/$matchId/',
  ])
})

test('an id that is no match on this device shows the not-found screen', async () => {
  renderRoute('/matches/nope')

  expect(await new NotFoundScreenPage().heading()).toBeVisible()
  expect(screen.queryByRole('heading', { name: /^You vs / })).toBeNull()
})

test('Score opens the next game’s scoring screen', async () => {
  const user = userEvent.setup()
  const matchId = await createMatch(5, [[11, 7]])
  const { router } = renderRoute(`/matches/${matchId}`)

  await user.click(await new MatchDetailsScreenPage().score())

  // Until the navigation lands, the only h1 is still the details page's.
  await vi.waitFor(async () =>
    expect(await new ScoringScreenPage().heading()).toHaveTextContent('Enter game 2 score.'),
  )
  expect(router.state.location.pathname).toBe(`/matches/${matchId}/games/2/scores/edit`)
})

test('the way back reaches /matches', async () => {
  const user = userEvent.setup()
  const matchId = await createMatch(5)
  const { router } = renderRoute(`/matches/${matchId}`)

  await user.click(await new MatchDetailsScreenPage().back())

  await vi.waitFor(() =>
    expect(router.state.location.pathname).toBe('/matches'),
  )
  expect(await new MatchListScreenPage().heading()).toBeVisible()
  expect(screen.queryByRole('heading', { name: /^You vs / })).toBeNull()
})
