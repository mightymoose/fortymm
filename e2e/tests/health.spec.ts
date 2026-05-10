import { test, expect } from '@playwright/test'

const API_URL = process.env.API_URL ?? 'http://127.0.0.1:8000'

test('GET /v1/health round-trips through Redis, RQ worker and the solver', async ({
  request,
}) => {
  const response = await request.get(`${API_URL}/v1/health`)
  expect(response.status()).toBe(200)
  expect(await response.json()).toEqual({ solver: { healthy: true } })
})
