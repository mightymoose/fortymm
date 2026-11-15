import { expect, test } from 'vitest'
import { DashboardScreenPage } from './DashboardScreen.page.tsx'

test('the dashboard is its heading and the New match button, a link to /matches/new, and nothing else', async () => {
  const dashboard = new DashboardScreenPage()
  dashboard.render()

  expect(await dashboard.heading()).toBeVisible()
  expect(await dashboard.newMatch()).toHaveAttribute('href', '/matches/new')
  expect(document.body).toHaveTextContent(/^DashboardNew match$/)
})
