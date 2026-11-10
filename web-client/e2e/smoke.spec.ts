import { expect, test } from '@playwright/test'

test('the starter page loads and responds to a click', async ({ page }) => {
  const pageErrors: Error[] = []
  page.on('pageerror', (error) => pageErrors.push(error))

  await page.goto('/')

  await expect(page).toHaveTitle('web-client')
  await expect(page.getByRole('heading', { name: 'Get started' })).toBeVisible()

  // A working counter proves the JavaScript bundle loaded and React rendered.
  await page.getByRole('button', { name: 'Count is 0' }).click()
  await expect(page.getByRole('button', { name: 'Count is 1' })).toBeVisible()

  expect(pageErrors).toEqual([])
})
