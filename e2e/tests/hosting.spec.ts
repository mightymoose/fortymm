import { expect, test } from '@playwright/test'
import { HealthPage } from '../pages/health-page.ts'
import { waitUntilAppIsKept } from '../pages/kept-app.ts'
import { NotFoundPage } from '../pages/not-found-page.ts'
import { StartPage } from '../pages/start-page.ts'

// The web client's production hosting, the Worker in web-client/worker/, as a
// person sees it: run in the local Workers runtime by the e2e task, or a
// deployment on Cloudflare's edge (web-client:hosting-check). What each URL
// shows is the router's business, proven by web-client's component tests;
// these prove the hosting hands the app every path it should. The HTTP rules
// behind them are in hosting-rules.spec.ts.

test('the hosting serves the app at a deep path, and the bundle runs', async ({
  page,
}) => {
  const pageErrors: Error[] = []
  page.on('pageerror', (error) => pageErrors.push(error))
  const notFound = new NotFoundPage(page)
  const start = new StartPage(page)

  await notFound.open('/no/such/page')
  await expect(notFound.heading).toBeVisible()

  await notFound.linkToStart.click()
  await expect(start.heading).toBeVisible()

  expect(pageErrors).toEqual([])
})

// The hosting has no proxy to the api yet: /api/* is a 404, never the app's
// page, so the health page, loaded directly, says it can't reach the api.
test('the hosted health page says it can’t reach the api, which the hosting does not serve yet', async ({
  page,
}) => {
  const health = new HealthPage(page)

  await health.open()

  await expect(health.unknown).toBeVisible()
})

// The shared core's WebAssembly module, as the hosting serves it, is one the
// browser instantiates: the page shows the core's answer for a fixed player
// id, its golden vector (core/vectors/vectors.json, "usernames").
test('the hosted health page loads the shared core and shows its answer', async ({
  page,
}) => {
  const health = new HealthPage(page)

  await health.open()

  await expect(health.coreLoaded).toContainText(/\bmerry-otter-0rdf\b/)
})

// The service worker keeps the app as the hosting serves it: every file of
// the build fetched as itself, never redirected, and the app's page answering
// every path. Opening it again with no connection proves all of that held.
test('after one visit, the hosted app opens with no connection, at a deep path too', async ({
  context,
  page,
}) => {
  await page.goto('/')
  await waitUntilAppIsKept(page)
  await page.close()
  await context.setOffline(true)

  const reopened = await context.newPage()
  const start = new StartPage(reopened)
  await reopened.goto('/')
  await expect(start.heading).toBeVisible()

  const notFound = new NotFoundPage(reopened)
  await notFound.open('/no/such/page')
  await expect(notFound.heading).toBeVisible()
})
