import { act } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'
import type { components } from '../api/schema'

// The API's base URL in unit tests. Node's Request rejects the app's
// relative `/api`.
export const API_BASE_URL = 'http://localhost/api'

export const sessionResponse: components['schemas']['SessionResponse'] = {
  data: {
    account: {
      id: '0b9e3c1e-58f4-4c84-9a59-2d0b6f3f6a10',
      kind: 'guest',
      email: null,
      player: {
        id: 'c4a8f6a2-1f0e-4a63-8d2e-7f5b9e1c3d42',
        display_name: 'excited egret 387',
      },
    },
  },
}

// The mock API for unit tests, started in setupTests.ts. Tests override a
// handler for themselves with `server.use()`.
export const server = setupServer(
  http.post(`${API_BASE_URL}/v1/session`, () =>
    HttpResponse.json(sessionResponse),
  ),
)

// Holds the mock API's session responses until the test sends them.
export function holdSession() {
  const requests: Request[] = []
  const pending: ((response: Response) => void)[] = []
  server.use(
    http.post(`${API_BASE_URL}/v1/session`, ({ request }) => {
      requests.push(request)
      return new Promise<Response>((resolve) => pending.push(resolve))
    }),
  )
  return {
    requests,
    async respond(response: Response): Promise<void> {
      await act(async () => pending.shift()!(response))
    },
  }
}
