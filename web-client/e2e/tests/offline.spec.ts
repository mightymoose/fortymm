import { expect, test } from '@playwright/test'
import {
  App,
  HealthPage,
  NotFoundPage,
  StartPage,
  waitUntilNewVersionTakesOver,
} from '../pages/app.ts'
import { deploy } from '../pages/deployment.ts'

// Opening the app with no connection, after one visit with one. Each test
// starts from a fresh browser profile with the current build deployed.
// "Opening" is loading the address directly in a new page, the way a tab or
// the home-screen icon does.

test.beforeEach(async () => {
  await deploy('current')
})

test('after one visit, the start page opens with no connection, and its counter counts', async ({
  context,
  page,
}) => {
  const app = new App(page)
  await app.open('/')
  await app.waitUntilKept()
  await page.close()
  await context.setOffline(true)

  const reopened = await context.newPage()
  const start = new StartPage(reopened)
  await new App(reopened).open('/')

  await expect(start.heading).toBeVisible()
  await start.counter(0).click()
  await expect(start.counter(1)).toBeVisible()
})

// /health is its own chunk (autoCodeSplitting), never loaded by the visit to
// the start page: it opens only if the whole build was kept. It can't reach
// the api with no connection, and says so.
test('after a visit to the start page only, /health opens with no connection, and says it can’t reach the api', async ({
  context,
  page,
}) => {
  const app = new App(page)
  await app.open('/')
  await app.waitUntilKept()
  await page.close()
  await context.setOffline(true)

  const reopened = await context.newPage()
  const health = new HealthPage(reopened)
  await new App(reopened).open('/health')

  await expect(health.heading).toBeVisible()
  await expect(health.unknown).toBeVisible()
})

// The core's WebAssembly module is a file of the build like any other, so the
// visit to the start page, which never loads it, keeps it too.
test('after a visit to the start page only, /health opens with no connection, and loads the shared core', async ({
  context,
  page,
}) => {
  const app = new App(page)
  await app.open('/')
  await app.waitUntilKept()
  await page.close()
  await context.setOffline(true)

  const reopened = await context.newPage()
  const health = new HealthPage(reopened)
  await new App(reopened).open('/health')

  await expect(health.coreLoaded).toContainText(/\bmerry-otter-0rdf\b/)
})

test('with no connection, an unknown path opens the app’s not-found page', async ({
  context,
  page,
}) => {
  const app = new App(page)
  await app.open('/')
  await app.waitUntilKept()
  await page.close()
  await context.setOffline(true)

  const reopened = await context.newPage()
  await new App(reopened).open('/no/such/page')

  await expect(new NotFoundPage(reopened).heading).toBeVisible()
})

// The update policy: a new deployment is kept on a visit with a connection
// and shown at the next opening, with or without a connection. A page that
// is open meanwhile (someone scoring a match) is never reloaded: its state,
// here the counter, is still there.
test('a new deployment is kept on a visit and shown at the next opening with no connection, and the open page is not reloaded', async ({
  context,
  page,
}) => {
  const app = new App(page)
  const start = new StartPage(page)
  await app.open('/')
  await app.waitUntilKept()
  await start.counter(0).click()
  await start.counter(1).click()
  await expect(page).toHaveTitle('fortymm')

  await deploy('next')
  const visit = await context.newPage()
  const visitApp = new App(visit)
  await visitApp.open('/')
  await visitApp.waitUntilNewVersionIsKept()

  await expect(start.counter(2)).toBeVisible()
  await expect(page).toHaveTitle('fortymm')

  await page.close()
  await visit.close()
  await waitUntilNewVersionTakesOver(context)
  await context.setOffline(true)
  const reopened = await context.newPage()
  await new App(reopened).open('/')

  await expect(reopened).toHaveTitle('fortymm (next deployment)')
  await expect(new StartPage(reopened).heading).toBeVisible()
})
