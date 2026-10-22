import { expect, test } from '../fixtures.ts'

test('reaches the database through the API', async ({ request }) => {
  const response = await request.get('/api/v1/health')

  expect(response.status()).toBe(200)
  expect(await response.json()).toEqual({ data: { database: 'ok' } })
})
