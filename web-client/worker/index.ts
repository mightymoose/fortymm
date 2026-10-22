// The Cloudflare Worker in front of the web-client's static assets (see
// wrangler.jsonc). Requests to /api/* go to the API on Cloud Run with the
// prefix stripped, as the Vite dev server's proxy does in dev, so the app's
// `/api` client works unchanged and same-origin; everything else is served
// from the assets, with the SPA fallback.

export interface Env {
  ASSETS: { fetch(request: Request): Promise<Response> }
  // The Cloud Run service (or tagged revision) URL, e.g.
  // https://fortymm-api-123456789012.us-central1.run.app. Passed with
  // `wrangler deploy --var`/`wrangler preview --var` (see mise.toml).
  API_ORIGIN?: string
}

const API_PREFIX = '/api'

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname.startsWith(`${API_PREFIX}/`)) {
      return proxyToApi(request, url, env)
    }
    return env.ASSETS.fetch(request)
  },
}

async function proxyToApi(request: Request, url: URL, env: Env): Promise<Response> {
  if (!env.API_ORIGIN) {
    return Response.json(
      { errors: [{ status: '503', title: 'The API is not configured for this deployment' }] },
      { status: 503 },
    )
  }

  const target = new URL(env.API_ORIGIN)
  target.pathname = url.pathname.slice(API_PREFIX.length)
  target.search = url.search

  const headers = new Headers(request.headers)
  // The upstream's own host, from the target URL, or Cloud Run can't route it.
  headers.delete('Host')
  headers.set('X-Forwarded-Host', url.host)
  headers.set('X-Forwarded-Proto', url.protocol.replace(/:$/, ''))
  const clientIp = request.headers.get('CF-Connecting-IP')
  if (clientIp) {
    headers.set('X-Forwarded-For', clientIp)
  }

  // The body is buffered (API requests are small); GET and HEAD can't have
  // one. Redirects go back to the browser rather than being followed here.
  const hasBody = request.method !== 'GET' && request.method !== 'HEAD'
  return fetch(target, {
    method: request.method,
    headers,
    body: hasBody ? await request.arrayBuffer() : undefined,
    redirect: 'manual',
  })
}
