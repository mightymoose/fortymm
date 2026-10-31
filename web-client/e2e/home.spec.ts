import { expect, test } from './fixtures.ts'

test('shows the roadmap title', async ({ homePage }) => {
  await homePage.goto()

  await expect(homePage.title).toHaveText('What’s coming, and when.')
})

test('shows the loading screen until the session starts, then the page in its place', async ({
  homePage,
  page,
}) => {
  let releaseSession!: () => void
  const sessionHeld = new Promise<void>((resolve) => {
    releaseSession = resolve
  })
  await page.route('**/api/v1/session', async (route) => {
    await sessionHeld
    await route.continue()
  })

  await homePage.open()

  await expect(homePage.loadingScreen).toBeVisible()
  await expect(homePage.loadingScreen).toContainText('FortyMM')
  await expect(homePage.title).toBeHidden()
  // Motion is feedback only, so nothing moves while it waits.
  expect(await page.evaluate('document.getAnimations().length')).toBe(0)

  releaseSession()

  await expect(homePage.title).toHaveText('What’s coming, and when.')
  // The page replaces the loading screen in one frame, with no fade.
  await expect(homePage.loadingScreen).toHaveCount(0)
})
