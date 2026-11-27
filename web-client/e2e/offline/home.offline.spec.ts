import { HomePage } from '../home.page.ts'
import { expect, test } from '@playwright/test'

test('home page loads offline once it has been visited', async ({ page, context }) => {
  const homePage = new HomePage(page)
  await homePage.goto()
  await homePage.waitUntilAvailableOffline()
  await context.setOffline(true)
  await page.reload()
  await expect(homePage.heading).toBeVisible()
})
