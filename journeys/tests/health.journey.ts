import { expect, test } from '@playwright/test'
import { HealthPage } from '../../web-client/e2e/pages.ts'

// The api answers through the web client's proxy and runs its core, and the browser loads the
// core's wasm: both sides show healthy only if every piece of the stack works.
test('health shows the core healthy in both the api and the web client', async ({ page }) => {
  const healthPage = new HealthPage(page)
  await healthPage.goto()
  await expect(healthPage.cores).toHaveText(['Core: healthy', 'Core: healthy'])
})
