import { expect, test } from './fixtures.ts'

test('shows the FortyMM title', async ({ homePage }) => {
  await homePage.goto()

  await expect(homePage.title).toHaveText('FortyMM')
})
