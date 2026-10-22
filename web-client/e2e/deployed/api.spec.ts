import { expect, test } from '../fixtures.ts'

test('serves the OpenAPI schema', async ({ request }) => {
  const response = await request.get('/api/openapi.json')

  expect(response.status()).toBe(200)
  expect(response.headers()['content-type']).toContain('application/json')
  expect((await response.json()).info.title).toBe('FortyMM API')
})

// Only the page's HTML: Swagger UI's scripts and styles come from a CDN.
test('serves the docs, loading the schema through /api', async ({
  request,
}) => {
  const response = await request.get('/api/docs')

  expect(response.status()).toBe(200)
  expect(response.headers()['content-type']).toContain('text/html')
  expect(await response.text()).toContain('/api/openapi.json')
})

// Without run_worker_first, the SPA fallback would answer with index.html.
test("answers unknown /api paths with the API's 404", async ({ request }) => {
  const response = await request.get('/api/v1/does-not-exist')

  expect(response.status()).toBe(404)
  expect(response.headers()['content-type']).toContain('application/json')
  expect(await response.json()).toEqual({ detail: 'Not Found' })
})
