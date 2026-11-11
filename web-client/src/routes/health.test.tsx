import { expect, test } from 'vitest'
import {
  answersWithTheApp,
  databaseUnavailable,
  healthy,
  healthyWhenReleased,
  internalServerError,
  unreachable,
} from '../test/api/health.ts'
import { server } from '../test/api/server.ts'
import { HealthPage } from './health.page.ts'

test('/health says the api is healthy when the api answers 200', async () => {
  server.use(healthy())
  const page = new HealthPage()
  await page.render()

  expect(await page.heading()).toBeVisible()
  expect(await page.healthy()).toBeVisible()
})

test('/health says the database is unavailable when the api answers 503 database_unavailable', async () => {
  server.use(databaseUnavailable())
  const page = new HealthPage()
  await page.render()

  expect(await page.databaseUnavailable()).toBeVisible()
  expect(await page.heading()).toBeVisible()
})

test('/health says the health is unknown when the api cannot be reached', async () => {
  server.use(unreachable())
  const page = new HealthPage()
  await page.render()

  expect(await page.unknown()).toBeVisible()
})

test('/health says the health is unknown when the answer is not JSON (the app’s own index.html, 200)', async () => {
  server.use(answersWithTheApp())
  const page = new HealthPage()
  await page.render()

  expect(await page.unknown()).toBeVisible()
})

test('/health says the health is unknown when the api answers 500', async () => {
  server.use(internalServerError())
  const page = new HealthPage()
  await page.render()

  expect(await page.unknown()).toBeVisible()
})

test('/health says it is checking while the answer is on its way, then gives the answer', async () => {
  const { handler, release } = healthyWhenReleased()
  server.use(handler)
  const page = new HealthPage()
  await page.render()

  expect(await page.checking()).toBeVisible()

  release()
  expect(await page.healthy()).toBeVisible()
})
