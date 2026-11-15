import { within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, test } from 'vitest'
import { AppLayoutPage } from '../components/AppLayout.page.tsx'
import { DashboardScreenPage } from '../components/DashboardScreen.page.tsx'
import { NewMatchScreenPage } from '../components/new-match/NewMatchScreen.page.tsx'
import { renderRoute } from '../test/render-route.tsx'

// The route's wiring. What the dashboard shows is its own test
// (src/components/DashboardScreen.test.tsx).
test('/ shows the dashboard in the layout’s one main landmark', async () => {
  renderRoute('/')

  const heading = await new DashboardScreenPage().heading()
  expect(
    within(await new AppLayoutPage().main()).getByRole('heading', {
      level: 1,
    }),
  ).toBe(heading)
})

test('the dashboard’s New match opens the new match screen, at /matches/new', async () => {
  const user = userEvent.setup()
  const { router } = renderRoute('/')

  await user.click(await new DashboardScreenPage().newMatch())

  expect(await new NewMatchScreenPage().heading()).toBeVisible()
  expect(router.state.location.pathname).toBe('/matches/new')
})
