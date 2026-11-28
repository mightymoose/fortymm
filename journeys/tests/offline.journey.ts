import { expect, test } from '@playwright/test'
import { DashboardPage } from '../../web-client/e2e/pages.ts'

// The built web client's service worker precaches the app on the first visit, so a reload with no
// network still renders it.
test('the dashboard loads offline once it has been visited', async ({ page, context }) => {
  const dashboardPage = new DashboardPage(page)
  await dashboardPage.goto()
  await dashboardPage.waitUntilAvailableOffline()
  await context.setOffline(true)
  await page.reload()
  await expect(dashboardPage.heading).toBeVisible()
})
