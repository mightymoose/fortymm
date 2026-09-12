import { expect, test } from '@playwright/test'
import { sessionResponse } from '../src/test/factories'

test('keeps a blocked sign-in retryable with the original merge consent', async ({ page }) => {
  const requests: unknown[] = []
  const message = 'Please wait before trying this sign-in again.'
  await page.route('**/api/v1/merge/preview', (route) => route.fulfill({
    json: { is_merge: true, owner_username: 'rita', guest_username: null,
      guest_matches_count: 2, adopts_guest_username: false },
  }))
  await page.route('**/api/v1/login/consume', async (route) => {
    requests.push(route.request().postDataJSON())
    await route.fulfill(requests.length === 1
      ? { status: 429, headers: { 'Retry-After': '1' }, json: { detail: message } }
      : { json: sessionResponse() })
  })
  await page.goto('/login/verifying?token=limited-token')
  await page.getByRole('button', { name: /not now — just sign me in/i }).click()
  await expect(page.getByText(message)).toBeVisible()
  await expect(page.getByRole('button', { name: 'Please wait before retrying' })).toBeDisabled()
  await expect(page.getByText('429 · LINK')).toBeVisible()
  const retry = page.getByRole('button', { name: 'Try again', exact: true })
  await expect(retry).toBeEnabled()
  expect(requests).toHaveLength(1)
  await retry.click()
  await expect(page).toHaveURL(/\/login\/welcome/)
  expect(requests).toEqual([
    { token: 'limited-token', skip_merge: true },
    { token: 'limited-token', skip_merge: true },
  ])
})
