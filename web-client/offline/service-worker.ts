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
//
// Updates: the browser fetches /sw.js again on each visit with a connection.
// When a new build has been deployed, its worker installs and waits; it takes
// over only once every page of the app has been closed. So a page that is
// open is never reloaded or changed underneath its user, and the next opening
// shows the new build, with or without a connection. There is no skipWaiting.

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
      // Only the first worker ever has a page to take: a later one activates
      // when no page of the app is open.
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
