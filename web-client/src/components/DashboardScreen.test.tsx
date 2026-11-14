import { expect, test } from 'vitest'
import { DashboardScreenPage } from './DashboardScreen.page.tsx'

test('the dashboard is its heading and nothing else', async () => {
  const dashboard = new DashboardScreenPage()
  dashboard.render()

  expect(await dashboard.heading()).toBeVisible()
  expect(document.body).toHaveTextContent(/^Dashboard$/)
})
