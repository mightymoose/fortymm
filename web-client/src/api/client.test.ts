import { expect, test, vi } from 'vitest'
import { createApiClient } from './client'

test('GETs a path under the API base URL and returns its typed body', async () => {
  const fetch = vi.fn(async (_request: Request) => Response.json({ data: 'pong' }))
  const api = createApiClient({ baseUrl: 'http://localhost/api', fetch })

  const { data } = await api.GET('/v1/ping')

  expect(fetch).toHaveBeenCalledOnce()
  expect(fetch.mock.calls[0][0]).toMatchObject({ url: 'http://localhost/api/v1/ping' })
  expect(data?.data).toBe('pong')
})
