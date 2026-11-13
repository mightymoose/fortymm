import { expect, test } from '@playwright/test'
import { HealthPage } from '../pages/health-page.ts'

// The journey across the two apps, as a person sees it: the web client's
// hosting, the Worker, given an api, forwards /api/v1/health to that api's
// /v1/health, and the api answers from its database. The page can only say
// the api is healthy if all of that held; anything else on the way (no
// forwarding, the prefix not stripped, the app's own index.html, another
// api) makes it say the health is unknown.
//
// Project api-journey: run by the e2e task against the local Workers runtime
// given api-release (api's production image, with its api-db), and by
// web-client:preview (CI's preview job) against a pull request's deployed
// Worker, given that pull request's api preview on Cloud Run with its own
// database. What the api answers over HTTP is proven in api/; what the page
// shows for each answer, in web-client's component tests.
test('the hosted health page reaches the api, which reaches its database', async ({
  page,
}) => {
  const health = new HealthPage(page)

  await health.open()

  await expect(health.healthy).toBeVisible()
})
