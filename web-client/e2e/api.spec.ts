import { expect, test } from './fixtures.ts'

test('proxies /api to the API', async ({ request }) => {
  const response = await request.get('/api/v1/ping')

  expect(response.ok()).toBe(true)
  expect(await response.json()).toEqual({ message: 'pong' })
})
