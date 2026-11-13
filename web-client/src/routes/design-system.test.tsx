import { expect, test } from 'vitest'
import { DesignSystemPage } from './design-system.page.ts'

test('/design-system shows a header with the FortyMM wordmark and the page’s level-1 heading', async () => {
  const page = new DesignSystemPage()
  await page.render()

  expect(await page.wordmark()).toBeVisible()
  expect(await page.heading()).toBeVisible()
})
