// The Cloudflare Worker in front of the web-client's static assets (see
// wrangler.jsonc). Requests on the redirect hosts get a 301 to fortymm.com.
// Requests to /api/* go to the API on Cloud Run with the
// prefix stripped, as the Vite dev server's proxy does in dev, so the app's
// `/api` client works unchanged and same-origin; everything else is served
// from the assets, with the SPA fallback.

export interface Env {
  ASSETS: { fetch(request: Request): Promise<Response> }
  // The Cloud Run service (or tagged revision) URL, e.g.
  // https://fortymm-api-123456789012.us-central1.run.app. Passed with
  // `wrangler deploy --var`/`wrangler preview --var` (see mise.toml).
  API_ORIGIN?: string
  // Sent to the API as X-FortyMM-Worker-Secret, which it requires on Cloud
  // Run. Passed with `--secrets-file` (see mise.toml).
  WORKER_SECRET?: string
  // Per-client-IP limit on /api/* (the `ratelimits` binding in wrangler.jsonc).
  API_RATE_LIMIT: RateLimit
  // Per-client-IP limit on POST /api/v1/session (the `ratelimits` binding in wrangler.jsonc).
  SESSION_RATE_LIMIT: RateLimit
}

// The Workers rate limiting binding.
interface RateLimit {
  limit(options: { key: string }): Promise<{ success: boolean }>
}

const API_PREFIX = '/api'
const SESSION_PATH = '/api/v1/session'
const WORKER_SECRET_HEADER = 'X-FortyMM-Worker-Secret'
const CANONICAL_ORIGIN = 'https://fortymm.com'
// Each host has its own cookie jar, so these redirect to one host. Previews
// run this code on other *.workers.dev hosts, so the names are exact.
const REDIRECT_HOSTS: ReadonlySet<string> = new Set(['www.fortymm.com', 'fortymm.mightymoose.workers.dev'])

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    if (REDIRECT_HOSTS.has(url.host)) {
      return Response.redirect(new URL(url.pathname + url.search, CANONICAL_ORIGIN).href, 301)
    }
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

  const clientIp = request.headers.get('CF-Connecting-IP')
  // Cloudflare always sets CF-Connecting-IP. Without it, the requests share one key.
  const key = clientIp ?? 'unknown'
  if (!(await env.API_RATE_LIMIT.limit({ key })).success) {
    return tooManyRequests()
  }
  if (
    request.method === 'POST' &&
    isSessionPath(url.pathname) &&
    !(await env.SESSION_RATE_LIMIT.limit({ key })).success
  ) {
    return tooManyRequests()
  }

  const target = new URL(env.API_ORIGIN)
  target.pathname = url.pathname.slice(API_PREFIX.length)
  target.search = url.search

  const headers = new Headers(request.headers)
  // The upstream's own host, from the target URL, or Cloud Run can't route it.
  headers.delete('Host')
  headers.set('X-Forwarded-Host', url.host)
  headers.set('X-Forwarded-Proto', url.protocol.replace(/:$/, ''))
  if (clientIp) {
    headers.set('X-Forwarded-For', clientIp)
  }
  // Never forward a client's own copy of the header.
  if (env.WORKER_SECRET) {
    headers.set(WORKER_SECRET_HEADER, env.WORKER_SECRET)
  } else {
    headers.delete(WORKER_SECRET_HEADER)
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

// The API percent-decodes the path before it routes, so /api/v1/%73ession
// also starts a session.
function isSessionPath(pathname: string): boolean {
  try {
    return decodeURIComponent(pathname) === SESSION_PATH
  } catch {
    return false
  }
}

function tooManyRequests(): Response {
  return Response.json(
    { errors: [{ status: '429', title: 'Too many requests' }] },
    { status: 429, headers: { 'Retry-After': '60' } },
  )
}
