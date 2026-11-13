import { expect, test } from '@playwright/test'
import { isTheAppPage } from '../pages/answers.ts'
import { HealthPage } from '../pages/health-page.ts'

// A Worker given no api (API_ORIGIN empty), as the production one is until a
// production api exists: /api and /api/* are a plain 404 for every method,
// never the app's page (which would look like an answer from the api) and
// never forwarded anywhere. Project worker-no-api: the local Workers runtime
// (web-client-worker), or a deployment (web-client:hosting-check --no-api).

const methods = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']

for (const method of methods) {
  for (const path of ['/api', '/api/', '/api/v1/health']) {
    test(`${method} ${path} is a plain 404, not the app’s page`, async ({
      request,
    }) => {
      const response = await request.fetch(path, {
        method,
        data: ['GET', 'HEAD'].includes(method) ? undefined : '{"x":1}',
      })

      expect(response.status()).toBe(404)
      expect(response.headers()['content-type']).toMatch(/^text\/plain\b/)
      expect(response.headers()['x-content-type-options']).toBe('nosniff')
      expect(await isTheAppPage(response)).toBe(false)
    })
  }
}

// What a person sees of it: the health page, loaded directly, says it can't
// reach the api.
test('the hosted health page says the api’s health is unknown', async ({
  page,
}) => {
  const health = new HealthPage(page)

  await health.open()

  await expect(health.unknown).toBeVisible()
})
