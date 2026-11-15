import { within } from '@testing-library/react'
import { expect, test } from 'vitest'
import { AppLayoutPage } from '../components/AppLayout.page.tsx'
import { DashboardScreenPage } from '../components/DashboardScreen.page.tsx'
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
