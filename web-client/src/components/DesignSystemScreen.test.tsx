import { expect, test } from 'vitest'
import { DesignSystemScreenPage } from './DesignSystemScreen.page.tsx'

test('the design system screen shows the FortyMM wordmark and the page’s level-1 heading', async () => {
  const page = new DesignSystemScreenPage()
  page.render()

  expect(await page.wordmark()).toBeVisible()
  expect(await page.heading()).toBeVisible()
})

test('the design system screen shows the controls, in the reference board’s sections', async () => {
  const page = new DesignSystemScreenPage()
  page.render()

  for (const part of [
    'Buttons',
    'Button sizes',
    'Fields',
    'Choices and selection',
    'Selection groups',
  ]) {
    expect(await page.controlsPart(part)).toBeVisible()
  }
})
