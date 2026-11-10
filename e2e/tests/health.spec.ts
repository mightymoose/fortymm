import { expect, test } from '@playwright/test'
import { HealthPage } from '../pages/health-page.ts'

// The wire between the web client and the api: the hosted build calls
// /api/v1/health on its own origin, the hosting forwards it to the api's
// /v1/health, and the api's production image answers from its real database.
// Today the hosting is web-client-hosting, an nginx stand-in for Cloudflare
// Workers. What the page shows for each answer is proven by web-client's
// component tests; this is the happy path only.
test('the hosted health page reaches the api, which reaches its database', async ({
  page,
}) => {
  const health = new HealthPage(page)
  const answer = page.waitForResponse((response) =>
    response.url().endsWith('/api/v1/health'),
  )

  await health.open()

  const response = await answer
  expect(response.status()).toBe(200)
  expect(response.headers()['content-type']).toContain('application/json')
  await expect(health.healthy).toBeVisible()
})
