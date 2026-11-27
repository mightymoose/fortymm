import { useRegisterSW } from 'virtual:pwa-register/react'
import { UpdateAvailableToast } from './UpdateAvailableToast.tsx'

// How often an open tab asks the server for a new service worker. The browser also checks on
// every page load.
const updateCheckIntervalMs = 60 * 60 * 1000

// Registers the service worker (production builds only; see vite.config.ts). When a new build's
// worker is installed and waiting, offers to reload onto it.
export function AppUpdate() {
  const {
    needRefresh: [needRefresh, setNeedRefresh],
    updateServiceWorker,
  } = useRegisterSW({
    onRegisteredSW(_swUrl, registration) {
      if (registration) {
        setInterval(() => void registration.update(), updateCheckIntervalMs)
      }
    },
  })
  if (!needRefresh) {
    return null
  }
  return (
    <UpdateAvailableToast
      onReload={() => void updateServiceWorker(true)}
      onDismiss={() => setNeedRefresh(false)}
    />
  )
}
