import { expect, test } from '@playwright/test'
import { NotFoundPage } from '../pages/not-found-page.ts'
import { StartPage } from '../pages/start-page.ts'

// The hosting in front of the web client: a deep path loaded directly gets the
// app, and the production bundle loads and mounts in a real browser. Today the
// hosting is web-client-hosting, an nginx stand-in for Cloudflare Workers;
// point this at the real hosting when it lands. What each URL shows is the
// router's business, proven by web-client's component tests.
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
  await start.counter(0).click()
  await expect(start.counter(1)).toBeVisible()

  expect(pageErrors).toEqual([])
})
