import { expect, test } from 'vitest'
import { HealthScreenPage } from '../components/HealthScreen.page.tsx'
import { healthy } from '../test/api/health.ts'
import { server } from '../test/api/server.ts'
import { renderRoute } from '../test/render-route.tsx'

// The route's wiring: its loader's two checks reach the screen. Nothing is
// faked but the api (MSW); the core is the real one (src/test/setup.ts).
// What each answer shows is the screen's test
// (src/components/HealthScreen.test.tsx); which answer the api's reply gives
// is fetchHealth's (src/api/health.test.ts); the core's is checkCore's
// (src/core/check.test.ts).
test('/health shows the health screen with the api’s answer and the shared core’s', async () => {
  server.use(healthy())
  renderRoute('/health')
  const page = new HealthScreenPage()

  expect(await page.healthy()).toBeVisible()
  expect(await page.coreLoaded()).toHaveTextContent(/\bmerry-otter-0rdf\b/)
})
