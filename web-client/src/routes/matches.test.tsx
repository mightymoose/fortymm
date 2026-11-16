import { within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, test } from 'vitest'
import { AppLayoutPage } from '../components/AppLayout.page.tsx'
import { MatchDetailsScreenPage } from '../components/match-details/MatchDetailsScreen.page.tsx'
import { MatchListScreenPage } from '../components/match-list/MatchListScreen.page.tsx'
import { NewMatchScreenPage } from '../components/new-match/NewMatchScreen.page.tsx'
import { createMatch } from '../test/match.ts'
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

test('/matches alone shows the matches list, through the layout route, in the layout’s one main landmark, with a match created through the store, whose link opens its details page at /matches/<id>', async () => {
  const user = userEvent.setup()
  // With game 1 saved, which leaves the list unread (no page watches it):
  // the route's loader reads it.
  const matchId = await createMatch(5, [[11, 7]])
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
    ['You vs Anonymous', 'Best of 5 · Unrated'],
  ])
  const link = list.matchLink(rows[0]!)
  expect(link).toHaveAttribute('href', `/matches/${matchId}`)

  await user.click(link)

  await expect
    .poll(() => router.state.location.pathname)
    .toBe(`/matches/${matchId}`)
  expect(await new MatchDetailsScreenPage().heading()).toHaveTextContent('You vs Anonymous')
})
