// The service worker that keeps the app on the device, so it opens with no
// connection. The build (offline/plugin.ts) turns this file into dist/sw.js,
// with BUILD written in front of it. web-client/README.md ("Opening with no
// connection") has the whole story.
//
// - Install: store every file of this build in a cache of its own.
// - Activate: delete the caches of earlier builds, and take control of the
//   page that registered it, so a first visit is covered at once.
// - Fetch: a file of the build comes from the cache; a page load (any path)
//   gets the cached index.html and the router decides what it shows, as the
//   hosting does online. Requests under /api/ are never answered here: they
//   always go to the network.
// - Message: a page asks a waiting worker to take over (Reload, in the
//   notice that a new version is ready, src/new-version.ts).
//
// Updates: the browser fetches /sw.js again on each page load with a
// connection, and an open page asks it to look now and then. When a new build
// has been deployed, its worker installs (keeps every file of its build) and
// waits. It takes over when every page of the app has been closed, or sooner
// only when the page asks (skipWaiting on that message, never otherwise); the
// page then reloads itself into the new build, from the cache. So a page that
// is open is never reloaded or changed underneath its user without their say.

// Written in front of this file by the build: the build's version (a hash of
// its files and of this worker) and the path of every file to keep.
declare const BUILD: { version: string; files: string[] }

const worker = self as unknown as ServiceWorkerGlobalScope

const cachePrefix = 'fortymm-app-'
const cacheName = `${cachePrefix}${BUILD.version}`
const kept = new Set(BUILD.files)
const appPage = '/index.html'

worker.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(cacheName)
      // From the network, not the browser's HTTP cache, so a file is never
      // an older build's copy. If one file fails, the install fails and the
      // browser tries again on the next visit.
      await cache.addAll(
        BUILD.files.map((path) => new Request(path, { cache: 'reload' })),
      )
    })(),
  )
})

worker.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const name of await caches.keys()) {
        if (name.startsWith(cachePrefix) && name !== cacheName) {
          await caches.delete(name)
        }
      }
      // Only the first worker has a page to take this way. A later one
      // activates when no page of the app is open, or when a page asked it
      // to take over, and then controls every open page by itself.
      await worker.clients.claim()
    })(),
  )
})

worker.addEventListener('fetch', (event) => {
  const { request } = event
  if (request.method !== 'GET') return
  const url = new URL(request.url)
  if (url.origin !== worker.location.origin) return
  // The api is never answered from the kept copy, not even the app's page.
  if (url.pathname === '/api' || url.pathname.startsWith('/api/')) return

  if (kept.has(url.pathname)) {
    event.respondWith(fromCache(url.pathname, request))
  } else if (request.mode === 'navigate') {
    event.respondWith(fromCache(appPage, request))
  }
})

// The kept copy, or the network if it is somehow missing from the cache.
async function fromCache(path: string, request: Request): Promise<Response> {
  const cache = await caches.open(cacheName)
  return (await cache.match(path)) ?? fetch(request)
}

// A page asks the waiting worker to take over, when its user pressed Reload
// (src/new-version.ts, takeOverMessage). Never without being asked. The page
// posts it only to the waiting worker; for one already active it changes
// nothing.
worker.addEventListener('message', (event) => {
  const data: unknown = event.data
  if (
    typeof data === 'object' &&
    data !== null &&
    (data as { type?: unknown }).type === 'take-over'
  ) {
    event.waitUntil(worker.skipWaiting())
  }
})
