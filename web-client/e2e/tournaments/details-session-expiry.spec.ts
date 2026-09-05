import { expect, test } from '@playwright/test'

import { TournamentDetailPage } from '../page-objects/tournaments/tournament-detail.page'
import { EVENT, TOURNAMENT_ID } from '../page-objects/tournaments/tournaments-store'

test('session expiry reaches login with a pending Details save and a dirty event editor', async ({ page }) => {
  const { pom } = await TournamentDetailPage.navigateTo(page)
  let release!: () => void
  const pending = new Promise<void>((resolve) => { release = resolve })
  await page.route(`**/v1/tournaments/${TOURNAMENT_ID}`, async (route) => {
    if (route.request().method() !== 'PATCH') return route.fallback()
    await pending
    await route.fulfill({
      status: 401,
      contentType: 'application/json',
      body: JSON.stringify({ detail: {
        code: 'session_ended',
        message: 'Your session has ended. Sign in to continue.',
      } }),
    })
  })

  await page.getByRole('tab', { name: 'Details' }).click()
  await page.getByRole('textbox', { name: /^Name/ }).fill('Updated tournament')
  const patch = page.waitForRequest((request) => request.method() === 'PATCH')
  await page.getByRole('button', { name: /Save changes/ }).click()
  await patch
  await page.getByRole('tab', { name: /^Events/ }).click()
  await pom.openEditor(EVENT.JOURNEY)
  await pom.eventNameInput.fill('Unsaved event edit')
  await expect(pom.eventNameInput).toHaveValue('Unsaved event edit')

  release()
  await expect(page).toHaveURL(/\/login(?:\?|$)/)
  await expect(page.getByRole('alertdialog')).toHaveCount(0)
})
