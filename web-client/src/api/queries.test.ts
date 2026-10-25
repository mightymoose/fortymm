import { http, HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'
import { API_BASE_URL, server } from '../test/server'
import { createApiClient } from './client'
import { createQueryClient, sessionQuery } from './queries'

// Starts the session through the app's QueryClient, with no delay between
// retries, against a mock API that answers each request with `answer()`.
async function startSession(answer: () => Response): Promise<number> {
  let requests = 0
  server.use(
    http.post(`${API_BASE_URL}/v1/session`, () => {
      requests++
      return answer()
    }),
  )
  const queryClient = createQueryClient()
  queryClient.setQueryDefaults(['v1', 'session'], { retryDelay: 0 })
  const query = sessionQuery(createApiClient({ baseUrl: API_BASE_URL }))
  await queryClient.fetchQuery(query).catch(() => {})
  return requests
}

describe('sessionQuery', () => {
  it('retries a 5xx', async () => {
    const requests = await startSession(() => new HttpResponse(null, { status: 503 }))

    expect(requests).toBe(4)
  })

  it('retries a network error', async () => {
    const requests = await startSession(() => HttpResponse.error())

    expect(requests).toBe(4)
  })

  it.each([415, 429])('does not retry a %i', async (status) => {
    const requests = await startSession(() => new HttpResponse(null, { status }))

    expect(requests).toBe(1)
  })
})
