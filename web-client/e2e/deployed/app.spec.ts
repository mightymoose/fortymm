import { expect, test } from '../fixtures.ts'

test('serves the app', async ({ homePage }) => {
  await homePage.goto()

  await expect(homePage.title).toHaveText('What’s coming, and when.')
})

// No file matches the path, so this loads through the SPA fallback.
test('serves client-side routes', async ({ designSystemPage }) => {
  await designSystemPage.goto()

  await expect(designSystemPage.title).toHaveText('Design System')
})
