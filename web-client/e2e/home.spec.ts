import { HomePage } from "./home.page.ts";
import { expect, test } from '@playwright/test'

test('home page shows the app name', async ({ page }) => {
  const homePage = new HomePage(page);
  await homePage.goto()
  await expect(homePage.heading).toBeVisible()
})
