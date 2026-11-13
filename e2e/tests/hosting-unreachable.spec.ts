import { expect, test } from '@playwright/test'
import { isTheAppPage } from '../pages/answers.ts'
import { HealthPage } from '../pages/health-page.ts'

// A Worker given an api it can't reach (project worker-unreachable: the local
// Workers runtime given a port nothing listens on). It answers at once with a
// plain 502: not a hang, and not the app's page.

test('GET /api/v1/health is a plain 502 at once, not the app’s page', async ({
  request,
}) => {
  const started = Date.now()
  const response = await request.get('/api/v1/health', { timeout: 10_000 })

  expect(Date.now() - started).toBeLessThan(10_000)
  expect(response.status()).toBe(502)
  expect(response.headers()['content-type']).toMatch(/^text\/plain\b/)
  expect(response.headers()['x-content-type-options']).toBe('nosniff')
  expect(await isTheAppPage(response)).toBe(false)
})

// The web client's health page already handles it, as any answer it doesn't
// understand.
test('the hosted health page says the api’s health is unknown', async ({
  page,
}) => {
  const health = new HealthPage(page)

  await health.open()

  await expect(health.unknown).toBeVisible()
})
