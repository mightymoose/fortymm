import { expect, test } from '@playwright/test'
import { LandingPage } from '../page-objects/landing.page'

test('landing page shows the hero heading', async ({ page }) => {
  const landingPage = await LandingPage.navigateTo(page)

  await expect(landingPage.heroHeading).toBeVisible()
})
