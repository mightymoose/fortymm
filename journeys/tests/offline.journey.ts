import { expect, test } from '@playwright/test'
import { HomePage } from '../../web-client/e2e/pages.ts'

// The built web client's service worker precaches the app on the first visit, so a reload with no
// network still renders it.
test('home page loads offline once it has been visited', async ({ page, context }) => {
  const homePage = new HomePage(page)
  await homePage.goto()
  await homePage.waitUntilAvailableOffline()
  await context.setOffline(true)
  await page.reload()
  await expect(homePage.heading).toBeVisible()
})
