import { expect, test } from 'vitest'
import type { Health } from '../api/health.ts'
import type { CoreCheck } from '../core/check.ts'
import { HealthScreenPage } from './HealthScreen.page.tsx'

// What the screen shows for each answer it is handed. Which api answer gives
// which Health is fetchHealth's (src/api/health.test.ts); what the core
// answers is checkCore's (src/core/check.test.ts); that /health hands the
// screen both is the route's (src/routes/health.test.tsx).

const coreLoaded: CoreCheck = {
  loaded: true,
  playerId: 'e2286f7cd2dc62c15a00bdb33f6e78167112a99a9f072d066e4e9dd3fc9d1c25',
  username: 'merry-otter-0rdf',
}

// An answer still on its way, until the test settles it.
function onItsWay<T>() {
  let settle!: (value: T) => void
  const promise = new Promise<T>((resolve) => {
    settle = resolve
  })
  return { promise, settle }
}

test('the health screen says the api is healthy when the answer is healthy', async () => {
  const page = new HealthScreenPage()
  page.render({
    health: Promise.resolve({ status: 'healthy' }),
    core: Promise.resolve(coreLoaded),
  })

  expect(await page.heading()).toBeVisible()
  expect(await page.healthy()).toBeVisible()
})

test('the health screen says the database is unavailable when the answer is database-unavailable', async () => {
  const page = new HealthScreenPage()
  page.render({
    health: Promise.resolve({ status: 'database-unavailable' }),
    core: Promise.resolve(coreLoaded),
  })

  expect(await page.databaseUnavailable()).toBeVisible()
  expect(await page.heading()).toBeVisible()
})

test('the health screen says the health is unknown when the answer is unknown', async () => {
  const page = new HealthScreenPage()
  page.render({
    health: Promise.resolve({ status: 'unknown' }),
    core: Promise.resolve(coreLoaded),
  })

  expect(await page.unknown()).toBeVisible()
})

test('the health screen says it is checking while the api’s answer is on its way, then gives the answer', async () => {
  const health = onItsWay<Health>()
  const page = new HealthScreenPage()
  page.render({ health: health.promise, core: Promise.resolve(coreLoaded) })

  expect(await page.checking()).toBeVisible()

  health.settle({ status: 'healthy' })
  expect(await page.healthy()).toBeVisible()
})

test('the health screen says the shared core loaded, with the username it gives the player', async () => {
  const page = new HealthScreenPage()
  page.render({
    health: Promise.resolve({ status: 'healthy' }),
    core: Promise.resolve(coreLoaded),
  })

  expect(await page.coreLoaded()).toHaveTextContent(/\bmerry-otter-0rdf\b/)
})

// The core doesn't wait for the api, which can take seconds to fail (a host
// that doesn't resolve) or never answer.
test('the health screen shows the shared core’s answer while the api’s answer is still on its way', async () => {
  const health = onItsWay<Health>()
  const page = new HealthScreenPage()
  page.render({ health: health.promise, core: Promise.resolve(coreLoaded) })

  expect(await page.coreLoaded()).toHaveTextContent(/\bmerry-otter-0rdf\b/)
  expect(await page.checking()).toBeVisible()

  health.settle({ status: 'healthy' })
  expect(await page.healthy()).toBeVisible()
})

test('the health screen says the shared core did not load when it didn’t, and still gives the api’s answer', async () => {
  const page = new HealthScreenPage()
  page.render({
    health: Promise.resolve({ status: 'healthy' }),
    core: Promise.resolve({ loaded: false }),
  })

  expect(await page.coreNotLoaded()).toBeVisible()
  expect(await page.healthy()).toBeVisible()
})
