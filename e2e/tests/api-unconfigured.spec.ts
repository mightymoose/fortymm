import { expect, test } from '@playwright/test'
import { isTheAppPage, methods } from '../pages/app-page.ts'

// The web client's Worker deployed without an api origin, as the production
// Worker is until the api has a production address (the Playwright project
// worker-without-api, web-client-worker-without-api in the stack). It has no
// api to forward to, and /api/* must still never be the app's page.
for (const method of methods) {
  test(`without an api, ${method} to /api and /api/* is a plain 404, never the app’s page`, async ({
    request,
  }) => {
    const wrong = []
    for (const path of ['/api', '/api/', '/api/v1/health']) {
      const response = await request.fetch(path, { method, maxRedirects: 0 })
      const headers = response.headers()
      if (
        response.status() !== 404 ||
        !headers['content-type']?.startsWith('text/plain') ||
        headers['x-content-type-options'] !== 'nosniff' ||
        (await isTheAppPage(response))
      ) {
        wrong.push(`${path}: ${response.status()} ${headers['content-type']}`)
      }
    }

    expect(wrong).toEqual([])
  })
}

test('without an api, a path outside /api still gets the app’s page', async ({
  request,
}) => {
  const response = await request.get('/health')

  expect(response.status()).toBe(200)
  expect(await isTheAppPage(response)).toBe(true)
})
