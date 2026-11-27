import { faker } from '@faker-js/faker'
import { http, HttpResponse } from 'msw'
import { getHealthUrl, type DocumentHealth } from '../api/generated.ts'

// MSW handlers for GET /api/v1/health. `ok` is the default (see handlers.ts); a test swaps in
// another with `server.use(health.serverError())`.
export const health = {
  ok: () => http.get(getHealthUrl(), () => HttpResponse.json<DocumentHealth>({ data: { server: 'ok', coreHealthy: true } })),
  // The api is up, but its core isn't working.
  coreUnhealthy: () =>
    http.get(getHealthUrl(), () =>
      HttpResponse.json<DocumentHealth>({ data: { server: 'ok', coreHealthy: false } }),
    ),
  serverError: () => http.get(getHealthUrl(), () => new HttpResponse(null, { status: 500 })),
  // A 200 whose document doesn't match the spec: any word but "ok".
  malformed: () =>
    http.get(getHealthUrl(), () =>
      HttpResponse.json({ data: { server: faker.lorem.word({ length: { min: 3, max: 10 } }) } }),
    ),
}
