import { expect, test } from './fixtures.ts'

test('shows the Design System title', async ({ designSystemPage }) => {
  await designSystemPage.goto()

  await expect(designSystemPage.title).toHaveText('Design System')
})

// Both tests below compare against the same screenshot, so the app's header
// has to render exactly like the reference kit's header with the app's copy
// swapped in. Update the screenshot with `npx playwright test
// --update-snapshots` only when the reference itself changes.
test.describe('header', () => {
  test('matches the screenshot', async ({ designSystemPage }) => {
    await designSystemPage.goto()

    await expect(designSystemPage.header).toHaveScreenshot('header.png')
  })

  test('matches the reference kit header', async ({
    designSystemPage,
    referenceKitPage,
  }) => {
    await designSystemPage.goto()
    const title = await designSystemPage.title.innerText()
    const subtitle = await designSystemPage.subtitle.innerText()

    await referenceKitPage.goto()
    await referenceKitPage.setHeaderText(title, subtitle)

    await expect(referenceKitPage.header).toHaveScreenshot('header.png')
  })
})
