import { within } from '@testing-library/react'
import { expect, test } from 'vitest'
import { AppLayoutPage } from '../components/AppLayout.page.tsx'
import { MatchListScreenPage } from '../components/match-list/MatchListScreen.page.tsx'
import { NewMatchScreenPage } from '../components/new-match/NewMatchScreen.page.tsx'
import { renderRoute } from '../test/render-route.tsx'

// The layout route's wiring. That the layout shows its child is its own test
// (src/components/Matches.test.tsx); what /matches/new shows is
// src/routes/matches/new.test.tsx; what the matches list shows, in each of
// its states, is its screen's (src/components/match-list/MatchListScreen.test.tsx).
test('/matches/new is reached through the /matches layout route', async () => {
  const { router } = renderRoute('/matches/new')

  expect(await new NewMatchScreenPage().heading()).toBeVisible()
  expect(router.state.matches.map((match) => match.routeId)).toEqual([
    '__root__',
    '/matches',
    '/matches/new',
  ])
})

test('/matches alone shows the matches list, through the layout route, in the layout’s one main landmark, with the three sample matches', async () => {
  const { router } = renderRoute('/matches')
  const list = new MatchListScreenPage()

  const heading = await list.heading()
  expect(
    within(await new AppLayoutPage().main()).getByRole('heading', {
      level: 1,
    }),
  ).toBe(heading)
  expect(router.state.matches.map((match) => match.routeId)).toEqual([
    '__root__',
    '/matches',
    '/matches/',
  ])
  const rows = await list.rows()
  expect(rows.map((row) => list.cells(row))).toEqual([
    ['You vs Chen', 'Best of 5 · Unrated', 'In progress · Game 1 next', '0 – 0'],
    ['You vs Ana', 'Best of 5 · Unrated', 'In progress · Game 4 next', '2 – 1'],
    ['You vs Ben', 'Best of 3 · Rated', 'Finished · You won', '2 – 0'],
  ])
  expect(await list.matchLink('You vs Ana')).toHaveAttribute(
    'href',
    '/matches/sample-1',
  )
})
