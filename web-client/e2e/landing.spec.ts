import { expect, test } from '@playwright/test'

test.describe('landing page', () => {
  test('renders the FortyMM hero', async ({ page }) => {
    await page.goto('/')

    await expect(
      page.getByRole('heading', { level: 1, name: /play more\.\s*pay never\./i }),
    ).toBeVisible()
  })

  test('switches the active product feature when a tab is clicked', async ({ page }) => {
    await page.goto('/')

    await expect(
      page.getByRole('heading', { name: /scores in, history out\./i }),
    ).toBeVisible()

    await page.getByRole('tab', { name: /run tournaments/i }).click()

    await expect(
      page.getByRole('heading', { name: /the schedule, solved\./i }),
    ).toBeVisible()
  })
})
