import { expect, test } from 'vitest'
import { API_BASE_URL } from '../test/server'
import { createApiClient } from './client'

test('GETs a path under the API base URL and returns its typed body', async () => {
  const api = createApiClient({ baseUrl: API_BASE_URL })

  const { data } = await api.GET('/v1/health')

  expect(data?.data.database).toBe('ok')
})
