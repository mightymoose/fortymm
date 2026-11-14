import { expect, test } from '@playwright/test'
import { isTheAppPage } from '../pages/app-page.ts'

// The web client's Worker with an api it can't reach (the Playwright project
// worker-api-unreachable; in the stack, web-client-worker-api-unreachable,
// whose api's name never resolves). The browser must get a plain answer that
// says so, at once: not the app's page, which the app would take for an
// answer, and not a request left hanging.
test('with the api unreachable, /api/v1/health is a plain-text 502 at once, not the app’s page', async ({
  request,
}) => {
  const response = await request.get('/api/v1/health', { timeout: 10_000 })

  expect(response.status()).toBe(502)
  expect(response.headers()['content-type']).toMatch(/^text\/plain\b/)
  expect(response.headers()['cache-control']).toBe('no-store')
  expect(response.headers()['x-content-type-options']).toBe('nosniff')
  expect(await isTheAppPage(response)).toBe(false)
})
