import { expect, test } from '@playwright/test'

test('landing page shows the hero heading', async ({ page }) => {
  await page.goto('/')

  const heading = page.getByRole('heading', {
    level: 1,
    name: /play more\.\s*pay never\./i,
  })
  await expect(heading).toBeVisible()
})
