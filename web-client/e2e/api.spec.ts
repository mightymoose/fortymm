import { expect, test } from './fixtures.ts'

test('proxies /api to the API', async ({ request }) => {
  const response = await request.get('/api/v1/health')

  expect(response.ok()).toBe(true)
  expect(await response.json()).toEqual({ data: { database: 'ok' } })
})
