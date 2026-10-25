import type { Page } from '@playwright/test'
import type { components } from '../src/api/schema.d.ts'
import { expect, test } from './fixtures.ts'
import { HomePage } from './pages/HomePage.ts'

type SessionAccount = components['schemas']['SessionAccount']

// The account that the session request answers with while `load` runs.
async function sessionDuring(page: Page, load: () => Promise<unknown>): Promise<SessionAccount> {
  // Reads the body as soon as it arrives. Chromium drops it once the page
  // navigates.
  const body: Promise<components['schemas']['SessionResponse']> = page
    .waitForResponse(
      (response) =>
        response.url().endsWith('/api/v1/session') && response.request().method() === 'POST',
    )
    .then((response) => response.json())
  await load()
  return (await body).data.account
}

test('keeps the account across a reload, and a new browser gets another', async ({
  homePage,
  page,
  browser,
  baseURL,
}) => {
  const first = await sessionDuring(page, () => homePage.goto())
  await expect(homePage.avatar(first.player.display_name)).toBeVisible()

  const reloaded = await sessionDuring(page, () => page.reload())
  expect(reloaded).toEqual(first)

  const otherBrowser = await browser.newContext({ baseURL })
  try {
    const other = new HomePage(await otherBrowser.newPage())
    const another = await sessionDuring(other.page, () => other.goto())
    expect(another.id).not.toBe(first.id)
    await expect(other.avatar(another.player.display_name)).toBeVisible()
  } finally {
    await otherBrowser.close()
  }
})

test('starts the session once per page load', async ({ homePage, page }) => {
  const sessionRequests: string[] = []
  page.on('request', (request) => {
    if (request.url().endsWith('/api/v1/session')) sessionRequests.push(request.method())
  })

  await homePage.goto()
  await page.waitForLoadState('networkidle')

  expect(sessionRequests).toEqual(['POST'])
})
