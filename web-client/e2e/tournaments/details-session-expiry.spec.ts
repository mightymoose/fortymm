import { expect, test } from '@playwright/test'

import { TournamentDetailPage } from '../page-objects/tournaments/tournament-detail.page'
import {
  EVENT,
  TOURNAMENT_ID,
} from '../page-objects/tournaments/tournaments-store'

test('session expiry reaches login with a pending Details save and a dirty event editor', async ({
  page,
}) => {
  const { pom } = await TournamentDetailPage.navigateTo(page)
  let release!: () => void
  const pending = new Promise<void>((resolve) => {
    release = resolve
  })
  await page.route(`**/v1/tournaments/${TOURNAMENT_ID}`, async (route) => {
    if (route.request().method() !== 'PATCH') return route.fallback()
    await pending
    await route.fulfill({
      status: 401,
      contentType: 'application/json',
      body: JSON.stringify({
        detail: {
          code: 'session_ended',
          message: 'Your session has ended. Sign in to continue.',
        },
      }),
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

for (const stalledMethod of ['PATCH', 'GET']) {
  test(`a stalled ${stalledMethod} times out, retains the draft, and releases navigation`, async ({
    page,
  }) => {
    await TournamentDetailPage.navigateTo(page)
    await page.clock.install()
    let release!: () => void
    const pending = new Promise<void>((resolve) => {
      release = resolve
    })
    await page.route(`**/v1/tournaments/${TOURNAMENT_ID}`, async (route) => {
      if (route.request().method() !== stalledMethod) return route.fallback()
      await pending
      await route.abort()
    })
    try {
      await page.getByRole('tab', { name: 'Details' }).click()
      await page
        .getByRole('textbox', { name: /^Name/ })
        .fill('Unsaved tournament')
      const stalledRequest = page.waitForRequest(
        (request) =>
          request.method() === stalledMethod &&
          request.url().endsWith(`/v1/tournaments/${TOURNAMENT_ID}`),
      )
      await page.getByRole('button', { name: /Save changes/ }).click()
      await stalledRequest
      await page.clock.fastForward(31_000)

      await expect(page.getByTestId('details-save-error')).toContainText(
        'The save took too long',
      )
      await expect(page.getByTestId('details-save-error')).toContainText(
        'may still complete',
      )
      await expect(page.getByTestId('details-save-error')).not.toContainText(
        'Nothing was saved',
      )
      await expect(page.getByRole('textbox', { name: /^Name/ })).toHaveValue(
        'Unsaved tournament',
      )
      await page
        .getByRole('button', { name: 'Tournaments', exact: true })
        .click()
      await expect(page).toHaveURL('/tournaments')
    } finally {
      release()
    }
  })
}

test('a save remains pending until its refetch finishes before a second save can begin', async ({
  page,
}) => {
  await TournamentDetailPage.navigateTo(page)
  let release!: () => void
  const pending = new Promise<void>((resolve) => {
    release = resolve
  })
  let refetchStarted!: () => void
  const refetch = new Promise<void>((resolve) => {
    refetchStarted = resolve
  })
  let patches = 0
  await page.route(`**/v1/tournaments/${TOURNAMENT_ID}`, async (route) => {
    if (route.request().method() === 'GET') {
      refetchStarted()
      await pending
    } else if (route.request().method() === 'PATCH' && ++patches === 2) {
      return route.fulfill({
        status: 422,
        contentType: 'application/json',
        body: JSON.stringify({
          detail: [{ loc: ['body', 'description'], msg: 'Rejected' }],
        }),
      })
    }
    return route.fallback()
  })
  try {
    await page.getByRole('tab', { name: 'Details' }).click()
    await page.getByRole('textbox', { name: /^Name/ }).fill('First saved name')
    await page.getByRole('button', { name: /Save changes/ }).click()
    await refetch
    await page
      .getByRole('textbox', { name: 'Description' })
      .fill('Second draft')
    await expect(
      page.getByRole('button', { name: /Save changes/ }),
    ).toBeDisabled()
    release()
    await expect(
      page.getByRole('button', { name: /Save changes/ }),
    ).toBeEnabled()
    await expect(
      page.getByRole('textbox', { name: 'Description' }),
    ).toHaveValue('Second draft')
    await page.getByRole('button', { name: /Save changes/ }).click()
    await expect(
      page.getByText(
        'The Description was rejected. Check that field and try again.',
      ),
    ).toBeVisible()
    await expect(
      page.getByRole('textbox', { name: 'Description' }),
    ).toHaveValue('Second draft')
  } finally {
    release()
  }
})
