import { HttpResponse } from 'msw'
import { http } from './server.ts'

// How the api's GET /v1/health can answer, for server.use(...) in a test.

const healthyDocument = {
  data: { type: 'health', id: 'api', attributes: { database: 'ok' } },
} as const

// 200: the api reached its database.
export const healthy = () =>
  http.get('/v1/health', ({ response }) => response(200).json(healthyDocument))

// 503: the api is up but its database did not answer.
export const databaseUnavailable = () =>
  http.get('/v1/health', ({ response }) =>
    response(503).json({
      errors: [
        {
          status: '503',
          code: 'database_unavailable',
          title: 'The database did not answer',
        },
      ],
    }),
  )

// 500: the api failed in a way it doesn't explain.
export const internalServerError = () =>
  http.get('/v1/health', ({ response }) =>
    response(500).json({
      errors: [
        {
          status: '500',
          code: 'internal_server_error',
          title: 'Internal Server Error',
        },
      ],
    }),
  )

// The request never gets an answer: the connection fails.
export const unreachable = () =>
  http.get('/v1/health', ({ response }) =>
    response.untyped(HttpResponse.error()),
  )

// What a host with no route to the api answers: the app's own index.html,
// with 200. Not in the api's document, so untyped on purpose.
export const answersWithTheApp = () =>
  http.get('/v1/health', ({ response }) =>
    response.untyped(
      HttpResponse.html('<!doctype html><div id="root"></div>', {
        status: 200,
      }),
    ),
  )

// Holds the healthy answer until the test calls release(), so the test can
// look at the page while the request is on its way.
export function healthyWhenReleased() {
  let release!: () => void
  const released = new Promise<void>((resolve) => {
    release = resolve
  })
  const handler = http.get('/v1/health', async ({ response }) => {
    await released
    return response(200).json(healthyDocument)
  })
  return { handler, release }
}
