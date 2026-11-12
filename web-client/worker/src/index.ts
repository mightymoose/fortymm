// web-client's production hosting: serves the production build (the ASSETS
// binding, web-client/dist; see wrangler.jsonc) and decides, for every
// request:
//
// - /api and /api/*: the api's, never the app's page. The proxy to the api
//   (api.fortymm.com, with /api stripped) is not built yet, so for now every
//   method gets a plain 404.
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
      // The proxy to the api goes here.
      return withHeaders(
        new Response('Not found\n', {
          status: 404,
          headers: { 'Content-Type': 'text/plain; charset=utf-8' },
        }),
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
