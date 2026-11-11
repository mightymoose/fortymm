import { expect, test } from '@playwright/test'
import { HealthPage } from '../pages/health-page.ts'

// The wire between the web client and the api, as a person sees it. The page
// can only say the api is healthy if the hosting forwarded /api/v1/health to
// the api's /v1/health and the api's production image answered from its real
// database; anything else on the way (no forwarding, the prefix not
// stripped, the app's own index.html) makes it say the health is unknown.
// Today the hosting is web-client-hosting, an nginx stand-in for Cloudflare
// Workers. What the api answers over HTTP is proven in api/; what the page
// shows for each answer, in web-client's component tests.
test('the hosted health page reaches the api, which reaches its database', async ({
  page,
}) => {
  const health = new HealthPage(page)

  await health.open()

  await expect(health.healthy).toBeVisible()
})
