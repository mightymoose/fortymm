import { expect, test } from 'vitest'
import { DesignSystemScreenPage } from './DesignSystemScreen.page.tsx'

test('the design system screen shows a header with the FortyMM wordmark and the page’s level-1 heading', async () => {
  const page = new DesignSystemScreenPage()
  page.render()

  expect(await page.wordmark()).toBeVisible()
  expect(await page.heading()).toBeVisible()
})
