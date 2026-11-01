import { expect, test } from './fixtures.ts'

// A desktop or a tablet can't install a phone beta, so the account menu links
// to the betas only at phone widths, below 600px. jsdom applies no media
// queries, so the unit tests can't check this. The test loads the page once,
// opens the menu and resizes it, because each load starts a guest account
// (see the limit in CLAUDE.md).
test('the account menu links to the iPhone beta only below 600px', async ({
  homePage,
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await homePage.goto()
  await homePage.accountButton.click()

  for (const width of [375, 599]) {
    await test.step(`${width}px: a menu item`, async () => {
      await page.setViewportSize({ width, height: 800 })
      await expect(homePage.iphoneAppItem).toBeVisible()
    })
  }

  for (const width of [600, 899, 1280]) {
    await test.step(`${width}px: none`, async () => {
      await page.setViewportSize({ width, height: 800 })
      await expect(homePage.accountMenu).toBeVisible()
      await expect(homePage.iphoneAppItem).toBeHidden()
    })
  }
})
