import { expect, test } from './fixtures.ts'

test('shows the Design System title', async ({ designSystemPage }) => {
  await designSystemPage.goto()

  await expect(designSystemPage.title).toHaveText('Design System')
})
