import { expect, test } from './fixtures.ts'

test('shows the FortyMM title', async ({ homePage }) => {
  await homePage.goto()

  await expect(homePage.title).toHaveText('FortyMM')
})

test('shows the loading screen, then the page', async ({ homePage }) => {
  await homePage.open()

  await expect(homePage.loadingScreen).toBeVisible()
  await expect(homePage.loadingScreen).toContainText('FortyMM')
  await expect(homePage.loadingScreen).toBeHidden({ timeout: 10_000 })
  await expect(homePage.title).toHaveText('FortyMM')
})
