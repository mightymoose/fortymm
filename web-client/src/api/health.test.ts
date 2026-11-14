import { expect, test } from 'vitest'
import {
  answersWithTheApp,
  databaseUnavailable,
  healthy,
  internalServerError,
  unreachable,
} from '../test/api/health.ts'
import { server } from '../test/api/server.ts'
import { fetchHealth } from './health.ts'

// Which Health each answer of the api's GET /v1/health gives. MSW stands in
// for the api (src/test/api/health.ts), typed from its document.

test('fetchHealth gives healthy when the api answers 200', async () => {
  server.use(healthy())
  expect(await fetchHealth()).toEqual({ status: 'healthy' })
})

test('fetchHealth gives database-unavailable when the api answers 503 database_unavailable', async () => {
  server.use(databaseUnavailable())
  expect(await fetchHealth()).toEqual({ status: 'database-unavailable' })
})

test('fetchHealth gives unknown when the api cannot be reached', async () => {
  server.use(unreachable())
  expect(await fetchHealth()).toEqual({ status: 'unknown' })
})

test('fetchHealth gives unknown when the answer is not JSON (the app’s own index.html, 200)', async () => {
  server.use(answersWithTheApp())
  expect(await fetchHealth()).toEqual({ status: 'unknown' })
})

test('fetchHealth gives unknown when the api answers 500', async () => {
  server.use(internalServerError())
  expect(await fetchHealth()).toEqual({ status: 'unknown' })
})
