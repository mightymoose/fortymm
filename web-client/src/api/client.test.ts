import { expect, test, vi } from 'vitest'
import { createApiClient } from './client'

test('GETs a path under the API base URL and returns its typed body', async () => {
  const fetch = vi.fn(async (_request: Request) => Response.json({ message: 'pong' }))
  const api = createApiClient({ baseUrl: 'http://localhost/api', fetch })

  const { data } = await api.GET('/v1/ping')

  expect(fetch).toHaveBeenCalledOnce()
  expect(fetch.mock.calls[0][0]).toMatchObject({ url: 'http://localhost/api/v1/ping' })
  expect(data?.message).toBe('pong')
})
