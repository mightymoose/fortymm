import { expect, test } from './fixtures.ts'

// A desktop or a tablet can't install a phone beta, so the app shell links to
// the betas only at phone widths, below 600px. jsdom applies no media
// queries, so the unit tests can't check this. The test loads the page once
// and resizes it, because each load starts a guest account (see the limit in
// CLAUDE.md).
test('shows the iPhone beta only below 600px', async ({ homePage, page }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await homePage.goto()

  for (const width of [375, 599]) {
    await test.step(`${width}px: a tab`, async () => {
      await page.setViewportSize({ width, height: 800 })
      await expect(homePage.iphoneAppLink).toBeVisible()
    })
  }

  for (const width of [600, 899, 1280]) {
    await test.step(`${width}px: hidden`, async () => {
      await page.setViewportSize({ width, height: 800 })
      await expect(homePage.iphoneAppLink).toBeHidden()
    })
  }

  await test.step('1280px, folded sidebar: hidden', async () => {
    await homePage.sidebarLabelsButton.click()
    await expect(homePage.sidebarLabelsButton).toHaveAttribute('aria-expanded', 'false')
    await expect(homePage.iphoneAppLink).toBeHidden()
  })
})
