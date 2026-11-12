import { expect, test } from '@playwright/test'
import { HealthPage } from '../pages/health-page.ts'
import { waitUntilAppIsKept } from '../pages/kept-app.ts'

// The wire between the web client and the api, as a person sees it. The page
// can only say the api is healthy if the hosting forwarded /api/v1/health to
// the api's /v1/health and the api's production image answered from its real
// database; anything else on the way (no forwarding, the prefix not
// stripped, the app's own index.html) makes it say the health is unknown.
// The production hosting, the Worker in web-client/worker/, has no proxy to
// the api yet, so these tests go through web-client-hosting, an nginx
// stand-in that forwards /api/* (the Playwright project api-wiring). Point
// them at the Worker when its proxy lands. What the api answers over HTTP is
// proven in api/; what the page shows for each answer, in web-client's
// component tests.
test('the hosted health page reaches the api, which reaches its database', async ({
  page,
}) => {
  const health = new HealthPage(page)

  await health.open()

  await expect(health.healthy).toBeVisible()
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
