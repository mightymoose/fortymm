import { showNewVersionOf, watchForNewVersion } from './new-version.ts'

// Registers the service worker that keeps the app on the device
// (offline/service-worker.ts, built into /sw.js), then watches it for a new
// deployment, which the layout offers to reload into (src/new-version.ts).
// Production builds only: the dev server registers none, so hot reload never
// fights a kept copy. After the page has loaded, so storing the app doesn't
// slow its first paint.
export function keepAppOnDevice() {
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return
  window.addEventListener(
    'load',
    () => {
      void navigator.serviceWorker.register('/sw.js').then((registration) => {
        showNewVersionOf(
          watchForNewVersion(registration, navigator.serviceWorker, () =>
            window.location.reload(),
          ),
        )
      })
    },
    { once: true },
  )
}
