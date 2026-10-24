import { expect, test } from './fixtures.ts'

test('shows the Design System title', async ({ designSystemPage }) => {
  await designSystemPage.goto()

  await expect(designSystemPage.title).toHaveText('Design System')
})

test('shows no loading screen and checks no health', async ({
  designSystemPage,
  page,
}) => {
  const healthRequests: string[] = []
  page.on('request', (request) => {
    if (request.url().includes('/api/v1/health')) {
      healthRequests.push(request.url())
    }
  })

  await designSystemPage.goto()
  await expect(designSystemPage.title).toBeVisible()
  await page.waitForLoadState('networkidle')

  await expect(designSystemPage.loadingScreen).toHaveCount(0)
  expect(healthRequests).toEqual([])
})

// Each pair of tests below compares the app and the reference gallery with
// the same screenshot, so the two must render identically. Update a
// screenshot with `npx playwright test --update-snapshots` only when the
// reference itself changes, then run again without the flag: the update
// writes whichever page it checks last and never fails.
test.describe('title', () => {
  test('matches the screenshot', async ({ designSystemPage }) => {
    await designSystemPage.goto()

    await expect(designSystemPage.title).toHaveScreenshot('title.png')
  })

  test("matches the gallery's title with the app's text", async ({
    designSystemPage,
    referenceKitPage,
  }) => {
    await designSystemPage.goto()
    const title = await designSystemPage.title.innerText()

    await referenceKitPage.goto()
    await referenceKitPage.setTitleText(title)

    await expect(referenceKitPage.title).toHaveScreenshot('title.png')
  })
})

// The intro uses the gallery's own copy, so it's compared with the gallery
// as is.
test.describe('intro', () => {
  test('matches the screenshot', async ({ designSystemPage }) => {
    await designSystemPage.goto()

    await expect(designSystemPage.intro).toHaveScreenshot('intro.png')
  })

  test("matches the gallery's intro", async ({ referenceKitPage }) => {
    await referenceKitPage.goto()

    await expect(referenceKitPage.intro).toHaveScreenshot('intro.png')
  })
})
