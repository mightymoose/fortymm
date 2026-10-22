import { expect, test } from '../fixtures.ts'

// Runs before the other specs (see playwright.deployed.config.ts), retrying
// until the deployment answers: a Cloud Run revision can be cold, and a
// Cloudflare Preview can take a moment to propagate.
test('forwards /api to the API', async ({ request }) => {
  test.setTimeout(90_000)

  await expect(async () => {
    const response = await request.get('/api/v1/ping')

    expect(response.status()).toBe(200)
    expect(await response.json()).toEqual({ data: 'pong' })
  }).toPass({ timeout: 60_000 })
})
