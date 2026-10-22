import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'
import type { components } from '../api/schema'

// The API's base URL in unit tests. Node's Request rejects the app's
// relative `/api`.
export const API_BASE_URL = 'http://localhost/api'

export const healthyResponse: components['schemas']['HealthResponse'] = {
  data: { database: 'ok' },
}

// The mock API for unit tests, started in setupTests.ts. Tests override a
// handler for themselves with `server.use()`.
export const server = setupServer(
  http.get(`${API_BASE_URL}/v1/health`, () =>
    HttpResponse.json(healthyResponse),
  ),
)
