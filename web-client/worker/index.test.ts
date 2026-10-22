import { afterEach, describe, expect, it, vi } from 'vitest'
import worker, { type Env } from './index'

const API_ORIGIN = 'https://fortymm-api-123.us-central1.run.app'

function makeEnv(overrides: Partial<Env> = {}) {
  const assets = vi.fn(async (_request: Request) => new Response('<!doctype html>'))
  const env: Env = { ASSETS: { fetch: assets }, API_ORIGIN, ...overrides }
  return { env, assets }
}

function stubUpstream() {
  const upstream = vi.fn(
    async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({ data: 'pong' }),
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
      new Request('https://fortymm.com/api/v1/ping?x=1', {
        headers: { 'CF-Connecting-IP': '203.0.113.7' },
      }),
      env,
    )

    expect(await response.json()).toEqual({ data: 'pong' })
    expect(assets).not.toHaveBeenCalled()
    const request = forwarded(upstream)
    expect(request.url).toBe(`${API_ORIGIN}/v1/ping?x=1`)
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

    const response = await worker.fetch(new Request('https://fortymm.com/api/v1/ping'), env)

    expect(response.status).toBe(503)
    expect(upstream).not.toHaveBeenCalled()
  })
})
