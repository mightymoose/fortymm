import { expect, test } from './fixtures.ts'

test('shows the FortyMM title', async ({ homePage }) => {
  await homePage.goto()

  await expect(homePage.title).toHaveText('FortyMM')
})

test('shows the loading screen until health answers, then fades it out over the page', async ({
  homePage,
  page,
}) => {
  let releaseHealth!: () => void
  const healthHeld = new Promise<void>((resolve) => {
    releaseHealth = resolve
  })
  await page.route('**/api/v1/health', async (route) => {
    await healthHeld
    await route.continue()
  })

  await homePage.open()

  await expect(homePage.loadingScreen).toBeVisible()
  await expect(homePage.loadingScreen).toContainText('FortyMM')
  await expect(homePage.title).toBeHidden()
  // Motion is feedback only, so nothing moves while it waits.
  expect(await page.evaluate('document.getAnimations().length')).toBe(0)

  // A string, because the e2e tsconfig has no DOM types.
  const fadeEnded = page.evaluate(`new Promise((resolve) => {
    document.addEventListener('animationend', (event) => {
      if (event.animationName === 'loading-screen-out') resolve()
    })
  })`)
  releaseHealth()

  await expect(homePage.title).toHaveText('FortyMM')
  await fadeEnded
  await expect(homePage.loadingScreen).toBeHidden()
})
