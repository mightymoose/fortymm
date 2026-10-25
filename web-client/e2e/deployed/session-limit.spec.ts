import { expect, test } from '../fixtures.ts'

// The attack in #88: a client that opens a new connection per request was
// never limited by the Worker's rate limit binding. Each request here gets a
// new request context, with no cookie jar and its connection closed, so each
// one starts a guest account. Runs last (see playwright.deployed.config.ts),
// because it spends this client's guest account budget for a minute.
test('limits new guest accounts from a client that opens a new connection each time', async ({
  playwright,
  baseURL,
}) => {
  test.setTimeout(120_000)
  const statuses: number[] = []
  let refused: { retryAfter: string | undefined; body: unknown } | undefined

  for (let i = 0; i < 31 && !refused; i++) {
    const context = await playwright.request.newContext({
      baseURL,
      extraHTTPHeaders: { Connection: 'close' },
    })
    try {
      const response = await context.post('/api/v1/session', { data: {} })
      statuses.push(response.status())
      if (response.status() === 429) {
        refused = { retryAfter: response.headers()['retry-after'], body: await response.json() }
      }
    } finally {
      await context.dispose()
    }
  }

  expect(refused, `no 429 after ${statuses.length} guest starts`).toBeDefined()
  const started = statuses.filter((status) => status === 200).length
  expect(statuses.slice(0, -1).every((status) => status === 200), `statuses: ${statuses}`).toBe(true)
  expect(started).toBeGreaterThanOrEqual(1)
  expect(started).toBeLessThanOrEqual(30)
  expect(Number(refused?.retryAfter)).toBeGreaterThanOrEqual(1)
  expect(Number(refused?.retryAfter)).toBeLessThanOrEqual(60)
  expect(refused?.body).toEqual({
    errors: [{ status: '429', title: 'Too many new guest accounts from this network' }],
  })
})
