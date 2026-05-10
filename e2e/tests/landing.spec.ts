import { test, expect } from '@playwright/test'

test('landing page renders the hero copy served by the web client', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: /Play more/ })).toBeVisible()
  await expect(
    page.getByRole('link', { name: /Start a match in your browser/ }),
  ).toBeVisible()
})
