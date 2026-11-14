import { useSyncExternalStore } from 'react'

// Tells an open page that a new deployment is on the device, ready to use,
// and switches to it when the person asks (README "Opening with no
// connection", "Updates"). Nothing here reloads a page by itself.
//
// - It asks the browser to look for a new deployment while the page is open
//   (`checkEvery`, when the page becomes visible again, when the connection
//   comes back), besides the look the browser takes on each page load.
// - It says a new version is ready only once the new build's worker is
//   installed and waiting: every file of the new build is then in its cache,
//   so the reload needs no network. A download that fails shows nothing; the
//   next look tries again.
// - Asked to reload, it tells the waiting worker to take over, and reloads
//   the page once that worker controls it, exactly once. The reload is then
//   served from the new build's cache, with or without a connection.
// - Dismissed, it hides until yet another deployment is ready.
//
// Several tabs: each one sees the same waiting worker, so each shows the
// notice, and only the tab whose Reload was pressed reloads. The new worker
// then controls every open tab, and the old build's cache is deleted as it
// takes over, so a tab still running the old build may fail to load a part
// it never loaded (a screen not opened yet). That tab shows the notice again,
// even if it was dismissed, and its Reload reloads at once: the new version
// already controls it.

// How often an open page asks whether a new version was deployed. The
// browser looks by itself only when a page of the app loads (and after push
// or background sync events, which this app's worker doesn't handle), so a
// page left open, as a scorer's is all day, would never learn of one. Each
// look is one request for /sw.js, past the HTTP cache, of a few kilobytes,
// which the browser compares with the worker it has.
// Fifteen minutes: deployments are rare, and nobody waits for one, so a
// shorter wait buys nothing; when the page comes back into view or the
// connection returns it looks at once, which covers a phone, whose page is
// out of view most of the time.
export const checkEvery = 15 * 60 * 1000

// The message a page posts to a waiting worker to make it take over
// (offline/service-worker.ts listens for it).
export const takeOverMessage = { type: 'take-over' } as const

// What this module uses of the browser's service worker objects, so a test
// can stand in for them (ServiceWorker, ServiceWorkerRegistration and
// navigator.serviceWorker all fit).
export interface KeptWorker extends EventTarget {
  readonly state: ServiceWorkerState
  postMessage(message: unknown): void
}
export interface Registration extends EventTarget {
  readonly installing: KeptWorker | null
  readonly waiting: KeptWorker | null
  update(): Promise<unknown>
}
export interface Container extends EventTarget {
  readonly controller: KeptWorker | null
}

export interface NewVersion {
  // Whether to show that a new version is ready.
  ready(): boolean
  subscribe(listener: () => void): () => void
  // The person pressed Reload.
  reload(): void
  // The person dismissed the notice.
  dismiss(): void
}

// Watches `registration` (this page's, from navigator.serviceWorker), and
// reloads with `reloadPage` only when asked to. Stops looking for new
// versions once `stop()` is called (tests).
export function watchForNewVersion(
  registration: Registration,
  container: Container,
  reloadPage: () => void,
): NewVersion & { stop(): void } {
  const listeners = new Set<() => void>()
  let ready = false
  let asked = false
  let reloaded = false
  // A page that has no controller is on its first visit: the first worker
  // takes control of it (clients.claim) and that is no new version.
  let controlled = container.controller !== null

  function show(value: boolean) {
    if (ready === value) return
    ready = value
    for (const listener of listeners) listener()
  }

  function reloadOnce() {
    if (reloaded) return
    reloaded = true
    reloadPage()
  }

  // A worker is installing: it is ready once installed. One that fails
  // becomes redundant, and nothing shows.
  function follow(worker: KeptWorker) {
    const settle = () => {
      if (worker.state === 'installed' && controlled) show(true)
      if (worker.state !== 'installing') {
        worker.removeEventListener('statechange', settle)
      }
    }
    worker.addEventListener('statechange', settle)
    settle()
  }

  if (registration.waiting !== null && controlled) show(true)
  if (registration.installing !== null) follow(registration.installing)
  registration.addEventListener('updatefound', () => {
    if (registration.installing !== null) follow(registration.installing)
  })

  container.addEventListener('controllerchange', () => {
    if (asked) {
      reloadOnce()
    } else if (controlled) {
      // Another tab's Reload: the new version controls this page too, and
      // this page still runs the old one.
      show(true)
    }
    controlled = true
  })

  function check() {
    // Fails with no connection; the next look tries again.
    registration.update().catch(() => {})
  }
  const onVisible = () => {
    if (document.visibilityState === 'visible') check()
  }
  document.addEventListener('visibilitychange', onVisible)
  window.addEventListener('online', check)
  const timer = setInterval(check, checkEvery)

  return {
    ready: () => ready,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    reload() {
      const waiting = registration.waiting
      if (waiting === null) {
        // Another tab already made the new version take over.
        reloadOnce()
        return
      }
      asked = true
      waiting.postMessage(takeOverMessage)
    },
    dismiss: () => show(false),
    stop() {
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('online', check)
      clearInterval(timer)
    },
  }
}

// What the page shows before the service worker is registered, in
// development (no service worker), and where there is none: nothing.
const nothing: NewVersion = {
  ready: () => false,
  subscribe: () => () => {},
  reload: () => {},
  dismiss: () => {},
}

let current: NewVersion = nothing
let unsubscribe = () => {}
const listeners = new Set<() => void>()
const notify = () => {
  for (const listener of listeners) listener()
}

// Makes `newVersion` the one the app's layout shows (src/keep-on-device.ts
// calls it once the service worker is registered).
export function showNewVersionOf(newVersion: NewVersion) {
  unsubscribe()
  current = newVersion
  unsubscribe = newVersion.subscribe(notify)
  notify()
}

// For the layout: whether a new version is ready, and the person's two
// answers.
export function useNewVersion() {
  const ready = useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => current.ready(),
  )
  return {
    ready,
    reload: () => current.reload(),
    dismiss: () => current.dismiss(),
  }
}
