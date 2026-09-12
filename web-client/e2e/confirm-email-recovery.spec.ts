import { expect, test } from '@playwright/test'
import { sessionResponse } from '../src/test/factories'

test('retains a conflicted confirmation for a manual retry after director resolution', async ({ page }) => {
  const requests: unknown[] = []
  const message = 'Ask the tournament director to resolve these entries before merging.'
  await page.route('**/api/v1/merge/preview', (route) => route.fulfill({
    json: { is_merge: false, guest_matches_count: 0, adopts_guest_username: false },
  }))
  await page.route('**/api/v1/me/email/confirm', async (route) => {
    requests.push(route.request().postDataJSON())
    await route.fulfill(requests.length === 1
      ? { status: 409, json: { detail: { code: 'entry_merge_conflict', message } } }
      : { json: sessionResponse() })
  })
  await page.goto('/confirm-email?token=conflicted-token')
  await expect(page.getByRole('heading', { name: 'Your entries need attention' })).toBeVisible()
  await expect(page.getByText(message)).toBeVisible()
  await expect(page).not.toHaveURL(/token=conflicted-token/)
  await expect(page.getByText('409 · LINK')).toBeVisible()
  expect(requests).toHaveLength(1)
  await page.getByRole('button', { name: 'Try again', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'You’re in.' })).toBeVisible()
  expect(requests).toEqual([
    { token: 'conflicted-token', skip_merge: false },
    { token: 'conflicted-token', skip_merge: false },
  ])
})
