import { expect, test } from '@playwright/test'
import {
  App,
  DesignSystemPage,
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

// The start page's heading is rendered by the app, so seeing it means the
// kept bundle ran.
test('after one visit, the start page opens with no connection', async ({
  context,
  page,
}) => {
  const app = new App(page)
  await new StartPage(page).goto()
  await app.waitUntilKept()
  await page.close()
  await context.setOffline(true)

  const reopened = await context.newPage()
  const start = new StartPage(reopened)
  await start.goto()

  await expect(start.heading).toBeVisible()
})

// /design-system is its own chunk, never loaded by the visit to the start
// page: it opens only if the whole build was kept.
test('after a visit to the start page only, /design-system opens with no connection, with its header', async ({
  context,
  page,
}) => {
  const app = new App(page)
  await new StartPage(page).goto()
  await app.waitUntilKept()
  await page.close()
  await context.setOffline(true)

  const reopened = await context.newPage()
  const designSystem = new DesignSystemPage(reopened)
  await designSystem.goto()

  await expect(designSystem.wordmark).toBeVisible()
  await expect(designSystem.heading).toBeVisible()
})

// /health is its own chunk (autoCodeSplitting), never loaded by the visit to
// the start page: it opens only if the whole build was kept. It can't reach
// the api with no connection, and says so.
test('after a visit to the start page only, /health opens with no connection, and says it can’t reach the api', async ({
  context,
  page,
}) => {
  const app = new App(page)
  await new StartPage(page).goto()
  await app.waitUntilKept()
  await page.close()
  await context.setOffline(true)

  const reopened = await context.newPage()
  const health = new HealthPage(reopened)
  await health.goto()

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
  await new StartPage(page).goto()
  await app.waitUntilKept()
  await page.close()
  await context.setOffline(true)

  const reopened = await context.newPage()
  const health = new HealthPage(reopened)
  await health.goto()

  await expect(health.coreLoaded).toContainText(/\bmerry-otter-0rdf\b/)
})

test('with no connection, an unknown path opens the app’s not-found page', async ({
  context,
  page,
}) => {
  const app = new App(page)
  await new StartPage(page).goto()
  await app.waitUntilKept()
  await page.close()
  await context.setOffline(true)

  const reopened = await context.newPage()
  await new NotFoundPage(reopened).goto()

  await expect(new NotFoundPage(reopened).heading).toBeVisible()
})

// The update policy: a new deployment is kept on a visit with a connection
// and shown at the next opening, with or without a connection. A page that
// is open meanwhile (someone scoring a match) is never reloaded: its state,
// here a value the test leaves in the page's window, is still there.
test('a new deployment is kept on a visit and shown at the next opening with no connection, and the open page is not reloaded', async ({
  context,
  page,
}) => {
  const app = new App(page)
  const start = new StartPage(page)
  await start.goto()
  await app.waitUntilKept()
  await page.evaluate(() => {
    ;(window as { leftByTheTest?: boolean }).leftByTheTest = true
  })
  await expect(page).toHaveTitle('fortymm')

  await deploy('next')
  const visit = await context.newPage()
  const visitApp = new App(visit)
  await new StartPage(visit).goto()
  await visitApp.waitUntilNewVersionIsKept()

  expect(
    await page.evaluate(
      () => (window as { leftByTheTest?: boolean }).leftByTheTest,
    ),
  ).toBe(true)
  await expect(page).toHaveTitle('fortymm')

  await page.close()
  await visit.close()
  await waitUntilNewVersionTakesOver(context)
  await context.setOffline(true)
  const reopened = await context.newPage()
  await new StartPage(reopened).goto()

  await expect(reopened).toHaveTitle('fortymm (next deployment)')
  await expect(new StartPage(reopened).heading).toBeVisible()
})
