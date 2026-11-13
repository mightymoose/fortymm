// web-client's production hosting: serves the production build (the ASSETS
// binding, web-client/dist; see wrangler.jsonc) and decides, for every
// request:
//
// - /api and /api/*: the api's, never a file of the build or the app's page.
//   A Worker given an api (API_ORIGIN, set at deploy: a pull request's
//   preview gets its own api preview, scripts/api-origin.sh) forwards them
//   to it with /api stripped: /api/v1/health?x=1 goes to
//   <API_ORIGIN>/v1/health?x=1, with the method, headers (but Host) and body,
//   and the api's answer comes back as it is, its redirects included. Only
//   the path and query come from the request; the scheme, host and port are
//   always API_ORIGIN's. An api that can't be reached gets a plain 502. A
//   Worker given none (the production one: there is no production api yet)
//   answers every method with a plain 404.
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
// - Everything: X-Content-Type-Options: nosniff.
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
    const { pathname } = new URL(request.url)

    if (pathname === '/api' || pathname.startsWith('/api/')) {
      return withHeaders(
        env.API_ORIGIN
          ? await toApi(request, env.API_ORIGIN)
          : plain(404, 'Not found\n'),
      )
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

// The request, sent to the api: its path with /api stripped, and its query,
// on API_ORIGIN's scheme, host and port. The target is the path set on a URL
// of the api, never the path resolved against the api's address, so no path
// (//host/x, /@host/x, /http://host/x) can name another host. Host must be
// the api's own (Cloud Run routes by it): the local Workers runtime sets it
// from the target whatever the request had, and it is dropped here so the
// edge does too. Redirects are handed back, not followed.
async function toApi(request: Request, apiOrigin: string): Promise<Response> {
  const from = new URL(request.url)
  const to = new URL(apiOrigin)
  to.pathname = from.pathname.slice('/api'.length) || '/'
  to.search = from.search
  const headers = new Headers(request.headers)
  headers.delete('Host')
  try {
    return await fetch(to, {
      method: request.method,
      headers,
      body: request.body,
      redirect: 'manual',
    })
  } catch {
    // Not reached at all (refused, no such host): an error the web client
    // treats like any answer it doesn't understand (its health page says
    // the api's health is unknown).
    return plain(502, 'The api can’t be reached\n')
  }
}

function plain(status: number, text: string): Response {
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
