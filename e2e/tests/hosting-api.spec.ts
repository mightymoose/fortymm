import { expect, test } from '@playwright/test'
import { isTheAppPage } from '../pages/answers.ts'
import { HealthPage } from '../pages/health-page.ts'
import { waitUntilAppIsKept } from '../pages/kept-app.ts'

// A Worker given a real api (project worker-api: the local Workers runtime
// given api-release, api's production image): what reaches the browser is
// the api's own answer, status and document, for every outcome. What is sent
// to the api, byte for byte, is in hosting-proxy.spec.ts, against an echo.

test('GET /api/v1/health is the api’s own document, 200', async ({
  request,
}) => {
  const response = await request.get('/api/v1/health')

  expect(response.status()).toBe(200)
  expect(response.headers()['content-type']).toMatch(/^application\/json\b/)
  expect(await response.json()).toEqual({
    data: { type: 'health', id: 'api', attributes: { database: 'ok' } },
  })
})

// The method reaches the api: as a GET this path would be a 200.
test('POST /api/v1/health is the api’s own 405', async ({ request }) => {
  const response = await request.post('/api/v1/health', { data: '{}' })

  expect(response.status()).toBe(405)
  expect((await response.json()).errors[0].status).toBe('405')
})

// A path the api doesn't have is the api's 404 document, not the Worker's
// plain one and not the app's page.
test('GET /api/v1/no-such-thing is the api’s own 404', async ({ request }) => {
  const response = await request.get('/api/v1/no-such-thing')

  expect(response.status()).toBe(404)
  expect(await isTheAppPage(response)).toBe(false)
  expect((await response.json()).errors[0].status).toBe('404')
})

// The browser keeps the app on the device, but never the api's answers: a
// request under /api/ always goes to the network. With a connection the page
// still gets the api's real answer (not the kept index.html, which it would
// call "unknown"), and an address under /api/ opened directly shows the api's
// document, not the app. Without one, it can't reach the api (not an answer
// kept from before, which would say "healthy").
test('with the app kept on the device, the health page still asks the api, and says it can’t reach it with no connection', async ({
  page,
  context,
}) => {
  const health = new HealthPage(page)
  await page.goto('/')
  await waitUntilAppIsKept(page)

  await health.open()
  await expect(health.healthy).toBeVisible()
  await page.goto('/api/v1/health')
  await expect(page.locator('body')).toContainText('"database":"ok"')

  await context.setOffline(true)
  await health.open()
  await expect(health.unknown).toBeVisible()
})
