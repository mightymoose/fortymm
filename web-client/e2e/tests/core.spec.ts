import { expect, test } from '@playwright/test'
import { App, HealthPage } from '../pages/app.ts'
import { deploy } from '../pages/deployment.ts'

// The shared core in the production build: its WebAssembly module is emitted
// into the build, and the app as it ships fetches and runs it. The name is the
// core's golden vector for the player id /health asks about
// (core/vectors/vectors.json, "usernames"): only the real module gives it.

test.beforeEach(async () => {
  await deploy('current')
})

test('the shipped app’s /health loads the shared core and shows its answer', async ({
  page,
}) => {
  const health = new HealthPage(page)
  await new App(page).open('/health')

  await expect(health.coreLoaded).toContainText(/\bmerry-otter-0rdf\b/)
})
