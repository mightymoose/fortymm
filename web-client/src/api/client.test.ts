import { expect, test } from 'vitest'
import { API_BASE_URL } from '../test/server'
import { createApiClient } from './client'

test('requests a path under the API base URL and returns its typed body', async () => {
  const api = createApiClient({ baseUrl: API_BASE_URL })

  const { data } = await api.POST('/v1/session', {
    headers: { 'Content-Type': 'application/json' },
  })

  expect(data?.data.account.kind).toBe('guest')
})
