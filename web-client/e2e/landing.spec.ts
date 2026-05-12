import { expect, test } from '@playwright/test'

test('landing page renders the hero heading', async ({ page }) => {
  await page.goto('/')

  const heading = page.getByRole('heading', { level: 1 })
  await expect(heading).toContainText('Play more.')
  await expect(heading).toContainText('Pay never.')
})
