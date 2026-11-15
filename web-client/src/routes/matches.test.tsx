import { within } from '@testing-library/react'
import { expect, test } from 'vitest'
import { AppLayoutPage } from '../components/AppLayout.page.tsx'
import { NotFoundScreenPage } from '../components/NotFoundScreen.page.tsx'
import { NewMatchScreenPage } from '../components/new-match/NewMatchScreen.page.tsx'
import { renderRoute } from '../test/render-route.tsx'

// The layout route's wiring. That the layout shows its child is its own test
// (src/components/Matches.test.tsx); what /matches/new shows is
// src/routes/matches/new.test.tsx.
test('/matches/new is reached through the /matches layout route', async () => {
  const { router } = renderRoute('/matches/new')

  expect(await new NewMatchScreenPage().heading()).toBeVisible()
  expect(router.state.matches.map((match) => match.routeId)).toEqual([
    '__root__',
    '/matches',
    '/matches/new',
  ])
})

test('/matches alone shows the not-found screen, inside the layout', async () => {
  renderRoute('/matches')

  const heading = await new NotFoundScreenPage().heading()
  expect(
    within(await new AppLayoutPage().main()).getByRole('heading', {
      level: 1,
      name: 'Page not found',
    }),
  ).toBe(heading)
})
