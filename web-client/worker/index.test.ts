/// <reference types="vite/client" />
import ts from 'typescript'
import { afterEach, describe, expect, it, vi } from 'vitest'
import wranglerText from '../wrangler.jsonc?raw'
import worker, { type Env } from './index'

const API_ORIGIN = 'https://fortymm-api-123.us-central1.run.app'

interface RateLimitConfig {
  name: string
  namespace_id: string
  simple: { limit: number; period: number }
}

const wrangler = ts.parseConfigFileTextToJson('wrangler.jsonc', wranglerText).config as {
  ratelimits: RateLimitConfig[]
  previews: { ratelimits: RateLimitConfig[] }
}

function rateLimitConfig(ratelimits: RateLimitConfig[], name: string) {
  const config = ratelimits.find((entry) => entry.name === name)
  if (!config) throw new Error(`wrangler.jsonc has no ${name}`)
  return config
}

function countingLimit(name: string) {
  const { limit } = rateLimitConfig(wrangler.ratelimits, name).simple
  const counts = new Map<string, number>()
  return vi.fn(async ({ key }: { key: string }) => {
    const count = (counts.get(key) ?? 0) + 1
    counts.set(key, count)
    return { success: count <= limit }
  })
}

function makeEnv(overrides: Partial<Env> = {}, { allowed = true } = {}) {
  const assets = vi.fn(async (_request: Request) => new Response('<!doctype html>'))
  const apiLimit = vi.fn(async (_options: { key: string }) => ({ success: allowed }))
  const sessionLimit = vi.fn(async (_options: { key: string }) => ({ success: true }))
  const env: Env = {
    ASSETS: { fetch: assets },
    API_ORIGIN,
    API_RATE_LIMIT: { limit: apiLimit },
    SESSION_RATE_LIMIT: { limit: sessionLimit },
    ...overrides,
  }
  return { env, assets, apiLimit, sessionLimit }
}

function makeCountingEnv() {
  return makeEnv({
    API_RATE_LIMIT: { limit: countingLimit('API_RATE_LIMIT') },
    SESSION_RATE_LIMIT: { limit: countingLimit('SESSION_RATE_LIMIT') },
  }).env
}

function postSession(path = '/api/v1/session', headers: Record<string, string> = {}) {
  return new Request(`https://fortymm.com${path}`, {
    method: 'POST',
    headers: { 'CF-Connecting-IP': '203.0.113.7', 'Content-Type': 'application/json', ...headers },
    body: '{}',
  })
}

async function statuses(requests: Request[], env: Env) {
  const result: number[] = []
  for (const request of requests) {
    result.push((await worker.fetch(request, env)).status)
  }
  return result
}

const SESSION_LIMIT = rateLimitConfig(wrangler.ratelimits, 'SESSION_RATE_LIMIT').simple.limit

function stubUpstream() {
  const upstream = vi.fn(
    async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({ data: { database: 'ok' } }),
  )
  vi.stubGlobal('fetch', upstream)
  return upstream
}

// What fetch was called with, as one Request.
function forwarded(upstream: ReturnType<typeof stubUpstream>) {
  const [input, init] = upstream.mock.calls[0]
  return new Request(input, init)
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('worker', () => {
  it('forwards /api/* to the API with the prefix stripped', async () => {
    const upstream = stubUpstream()
    const { env, assets } = makeEnv()

    const response = await worker.fetch(
      new Request('https://fortymm.com/api/v1/health?x=1', {
        headers: { 'CF-Connecting-IP': '203.0.113.7' },
      }),
      env,
    )

    expect(await response.json()).toEqual({ data: { database: 'ok' } })
    expect(assets).not.toHaveBeenCalled()
    const request = forwarded(upstream)
    expect(request.url).toBe(`${API_ORIGIN}/v1/health?x=1`)
    expect(request.method).toBe('GET')
    expect(request.redirect).toBe('manual')
    expect(request.headers.get('X-Forwarded-Host')).toBe('fortymm.com')
    expect(request.headers.get('X-Forwarded-Proto')).toBe('https')
    expect(request.headers.get('X-Forwarded-For')).toBe('203.0.113.7')
  })

  it('forwards the method, headers and body', async () => {
    const upstream = stubUpstream()
    const { env } = makeEnv()

    await worker.fetch(
      new Request('https://fortymm.com/api/v1/things', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer t' },
        body: JSON.stringify({ name: 'x' }),
      }),
      env,
    )

    const request = forwarded(upstream)
    expect(request.method).toBe('POST')
    expect(request.headers.get('Content-Type')).toBe('application/json')
    expect(request.headers.get('Authorization')).toBe('Bearer t')
    expect(await request.text()).toBe('{"name":"x"}')
  })

  it('serves other paths from the static assets', async () => {
    const upstream = stubUpstream()
    const { env, assets } = makeEnv()

    const response = await worker.fetch(new Request('https://fortymm.com/design-system'), env)

    expect(await response.text()).toBe('<!doctype html>')
    expect(assets).toHaveBeenCalledOnce()
    expect(upstream).not.toHaveBeenCalled()
  })

  it('answers 503 when API_ORIGIN is not set', async () => {
    const upstream = stubUpstream()
    const { env } = makeEnv({ API_ORIGIN: undefined })

    const response = await worker.fetch(new Request('https://fortymm.com/api/v1/health'), env)

    expect(response.status).toBe(503)
    expect(upstream).not.toHaveBeenCalled()
  })

  it('sends the Worker secret to the API', async () => {
    const upstream = stubUpstream()
    const { env } = makeEnv({ WORKER_SECRET: 's3cret' })

    await worker.fetch(new Request('https://fortymm.com/api/v1/health'), env)

    expect(forwarded(upstream).headers.get('X-FortyMM-Worker-Secret')).toBe('s3cret')
  })

  it("replaces a client's own Worker secret header", async () => {
    const upstream = stubUpstream()
    const { env } = makeEnv({ WORKER_SECRET: 's3cret' })

    await worker.fetch(
      new Request('https://fortymm.com/api/v1/health', {
        headers: { 'X-FortyMM-Worker-Secret': 'guess' },
      }),
      env,
    )

    expect(forwarded(upstream).headers.get('X-FortyMM-Worker-Secret')).toBe('s3cret')
  })

  it("removes a client's own Worker secret header when WORKER_SECRET is not set", async () => {
    const upstream = stubUpstream()
    const { env } = makeEnv()

    await worker.fetch(
      new Request('https://fortymm.com/api/v1/health', {
        headers: { 'X-FortyMM-Worker-Secret': 'guess' },
      }),
      env,
    )

    expect(forwarded(upstream).headers.has('X-FortyMM-Worker-Secret')).toBe(false)
  })

  it('rate limits by the client IP', async () => {
    stubUpstream()
    const { env, apiLimit } = makeEnv()

    await worker.fetch(
      new Request('https://fortymm.com/api/v1/health', {
        headers: { 'CF-Connecting-IP': '203.0.113.7' },
      }),
      env,
    )

    expect(apiLimit).toHaveBeenCalledWith({ key: '203.0.113.7' })
  })

  it('answers 429 to the session POST over the limit without calling the API', async () => {
    const upstream = stubUpstream()
    const env = makeCountingEnv()

    const allowed = await statuses(Array.from({ length: SESSION_LIMIT }, () => postSession()), env)
    const over = await worker.fetch(postSession(), env)

    expect(allowed).toEqual(Array(SESSION_LIMIT).fill(200))
    expect(upstream).toHaveBeenCalledTimes(SESSION_LIMIT)
    expect(over.status).toBe(429)
    expect(over.headers.get('Retry-After')).toBe('60')
    expect(await over.json()).toEqual({ errors: [{ status: '429', title: 'Too many requests' }] })
  })

  it('does not count other /api/* requests against the session limit', async () => {
    const upstream = stubUpstream()
    const env = makeCountingEnv()
    const health = Array.from(
      { length: 50 },
      () => new Request('https://fortymm.com/api/v1/health', { headers: { 'CF-Connecting-IP': '203.0.113.7' } }),
    )

    const healthStatuses = await statuses(health, env)
    const sessionStatuses = await statuses(Array.from({ length: SESSION_LIMIT }, () => postSession()), env)
    const over = await worker.fetch(postSession(), env)

    expect(healthStatuses).toEqual(Array(50).fill(200))
    expect(sessionStatuses).toEqual(Array(SESSION_LIMIT).fill(200))
    expect(upstream).toHaveBeenCalledTimes(50 + SESSION_LIMIT)
    expect(over.status).toBe(429)
  })

  it('keys the session limit by the client IP, not the cookie', async () => {
    stubUpstream()
    const { env, sessionLimit } = makeEnv()

    await worker.fetch(postSession('/api/v1/session', { Cookie: '__Host-fortymm_session=abc' }), env)

    expect(sessionLimit).toHaveBeenCalledWith({ key: '203.0.113.7' })
  })

  it('counts a percent-encoded session path against the session limit', async () => {
    stubUpstream()
    const { env, sessionLimit } = makeEnv()

    await worker.fetch(postSession('/api/v1/%73ession'), env)

    expect(sessionLimit).toHaveBeenCalledWith({ key: '203.0.113.7' })
  })

  it('limits sessions to the same rate in production and Previews, with separate counts', () => {
    const production = rateLimitConfig(wrangler.ratelimits, 'SESSION_RATE_LIMIT')
    const preview = rateLimitConfig(wrangler.previews.ratelimits, 'SESSION_RATE_LIMIT')
    const namespaces = [...wrangler.ratelimits, ...wrangler.previews.ratelimits].map((entry) => entry.namespace_id)

    expect(production.simple).toEqual({ limit: 30, period: 60 })
    expect(preview.simple).toEqual({ limit: 30, period: 60 })
    expect(new Set(namespaces).size).toBe(namespaces.length)
  })

  it('answers 429 without calling the API when the client is over the limit', async () => {
    const upstream = stubUpstream()
    const { env } = makeEnv({}, { allowed: false })

    const response = await worker.fetch(new Request('https://fortymm.com/api/v1/health'), env)

    expect(response.status).toBe(429)
    expect(response.headers.get('Retry-After')).toBe('60')
    expect(await response.json()).toEqual({
      errors: [{ status: '429', title: 'Too many requests' }],
    })
    expect(upstream).not.toHaveBeenCalled()
  })

  it.each([
    ['https://www.fortymm.com/', 'https://fortymm.com/'],
    ['https://www.fortymm.com/x?y=1', 'https://fortymm.com/x?y=1'],
    ['https://fortymm.mightymoose.workers.dev/x?y=1', 'https://fortymm.com/x?y=1'],
    ['https://www.fortymm.com/api/v1/health?x=1', 'https://fortymm.com/api/v1/health?x=1'],
  ])('redirects %s to %s', async (from, to) => {
    const upstream = stubUpstream()
    const { env, assets, apiLimit, sessionLimit } = makeEnv()

    const response = await worker.fetch(new Request(from), env)

    expect(response.status).toBe(301)
    expect(response.headers.get('Location')).toBe(to)
    expect(assets).not.toHaveBeenCalled()
    expect(apiLimit).not.toHaveBeenCalled()
    expect(sessionLimit).not.toHaveBeenCalled()
    expect(upstream).not.toHaveBeenCalled()
  })

  it('serves a Preview host without a redirect', async () => {
    stubUpstream()
    const { env, assets } = makeEnv()

    const response = await worker.fetch(
      new Request('https://feat-canonize-urls-fortymm.mightymoose.workers.dev/design-system'),
      env,
    )

    expect(response.status).toBe(200)
    expect(assets).toHaveBeenCalledOnce()
  })
})
