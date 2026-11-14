// web-client's production hosting: serves the production build (the ASSETS
// binding, web-client/dist; see wrangler.jsonc) and decides, for every
// request:
//
// - /api and /api/*: the api's, never the app's page. Forwarded to the api at
//   API_ORIGIN, the deployment's configuration (wrangler.jsonc, set by
//   web-client:deploy), with /api stripped: /api/v1/health to
//   <API_ORIGIN>/v1/health. A deployment without one (the production Worker,
//   until the api has a production address) answers a plain 404 for every
//   method; an api it can't reach, a plain 502 (toApi says what passes).
// - A file of the build: that file.
// - Any other path: the app's page (index.html), and the router decides what
//   it shows, its own not-found page included. Except under /assets/, and for
//   /sw.js and /manifest.webmanifest, where a missing file is a 404: a script
//   or style answered with a page breaks the app in confusing ways, and a
//   service worker answered with one would be refused. Only for GET and HEAD:
//   other methods keep the assets' answer (404, or 405 for a file).
//
// And the headers (web-client/README.md, "Hosting", says why each one):
//
// - The app's page, /sw.js and /manifest.webmanifest: Cache-Control: no-cache,
//   so a deployment is seen at once and the browser always checks for a new
//   service worker. Workers responses are never kept by Cloudflare's edge
//   cache, so the browser always reaches this deployment's file.
// - Files under /assets/, whose names carry a hash of their content: cached
//   for a year, immutable.
// - The api's answers: Cache-Control: no-store, whatever the api says: the
//   browser always asks the api (the service worker never keeps them either).
// - Everything: X-Content-Type-Options: nosniff, the api's answers included.
//
// Content types are the assets' own, from each file's extension (sw.js is
// JavaScript, manifest.webmanifest is application/manifest+json).

const appPage = '/index.html'
const noCache = 'no-cache'
const immutable = 'public, max-age=31536000, immutable'

// Files the browser must get as themselves or not at all: never the app's
// page in their place.
const neverTheAppPage = new Set(['/sw.js', '/manifest.webmanifest'])
const uncached = new Set(['/', appPage, '/sw.js', '/manifest.webmanifest'])

export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    const { pathname } = url

    if (pathname === '/api' || pathname.startsWith('/api/')) {
      if (!env.API_ORIGIN) {
        return withHeaders(plainText(404, 'Not found\n'))
      }
      return toApi(request, url, env.API_ORIGIN)
    }

    const file = await env.ASSETS.fetch(request)
    if (file.status === 404 && fallsBackToAppPage(request.method, pathname)) {
      const page = await env.ASSETS.fetch(
        new Request(new URL(appPage, request.url), request),
      )
      return withHeaders(page, { 'Cache-Control': noCache })
    }

    if (uncached.has(pathname)) {
      return withHeaders(file, { 'Cache-Control': noCache })
    }
    if (pathname.startsWith('/assets/') && (file.ok || file.status === 304)) {
      return withHeaders(file, { 'Cache-Control': immutable })
    }
    return withHeaders(file)
  },
} satisfies ExportedHandler<Env>

// Forwards a request under /api to the api at `origin` (https://host, no
// path), and gives back its answer. To the browser the api is the app's own
// server, on the app's origin, so the proxy is transparent, as Vite's proxy
// is in dev:
//
// - The path with /api stripped, and the query. The rest of the path is
//   appended to the origin as text, never resolved against it, so a path
//   such as /api//example.com/x still goes to the api's host.
// - Every method, every request header (cookies and Authorization included)
//   but Host, which is the api's own, and the body as it streams in.
// - The api's status, headers and body as they are, except: Cache-Control:
//   no-store and nosniff, whatever the api says; and a redirect to the api's
//   own address points under /api on the app's origin instead, so the
//   browser never leaves it (the api builds absolute URLs from its own host).
//   Redirects are handed to the browser, never followed here.
// - An api that can't be reached (a refused connection, a name that doesn't
//   resolve): a plain-text 502, never the app's page.
async function toApi(
  request: Request,
  url: URL,
  origin: string,
): Promise<Response> {
  const target = new URL(
    origin + (url.pathname.slice('/api'.length) || '/') + url.search,
  )
  const headers = new Headers(request.headers)
  headers.delete('Host')

  let answer: Response
  try {
    answer = await fetch(target, {
      method: request.method,
      headers,
      body:
        request.method === 'GET' || request.method === 'HEAD'
          ? null
          : request.body,
      redirect: 'manual',
    })
  } catch {
    answer = plainText(502, 'The api can’t be reached\n')
  }

  const rules: Record<string, string> = { 'Cache-Control': 'no-store' }
  const location = answer.headers.get('Location')
  if (location) {
    const to = new URL(location, target)
    if (to.host === target.host) {
      rules['Location'] = `/api${to.pathname}${to.search}${to.hash}`
    }
  }
  return withHeaders(answer, rules)
}

function plainText(status: number, text: string): Response {
  return new Response(text, {
    status,
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  })
}

// Only a page load (GET or HEAD) gets the app's page; any other method keeps
// the assets' own answer.
function fallsBackToAppPage(method: string, pathname: string): boolean {
  return (
    (method === 'GET' || method === 'HEAD') &&
    !pathname.startsWith('/assets/') &&
    !neverTheAppPage.has(pathname)
  )
}

// A copy of the response (the assets' headers can't be changed in place)
// with nosniff and the given headers.
function withHeaders(
  response: Response,
  headers: Record<string, string> = {},
): Response {
  const copy = new Response(response.body, response)
  copy.headers.set('X-Content-Type-Options', 'nosniff')
  for (const [name, value] of Object.entries(headers)) {
    copy.headers.set(name, value)
  }
  return copy
}
