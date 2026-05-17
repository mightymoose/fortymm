import { useEffect, useRef } from 'react'
import { useRegisterSW } from 'virtual:pwa-register/react'
import { toast } from 'sonner'

const TOAST_ID = 'sw-update-available'
const UPDATE_INTERVAL_MS = 15 * 60 * 1000
// Floor between successive update() calls so rapid tab switching doesn't spam
// the network. Browsers throttle setInterval in hidden tabs, but
// visibilitychange has no such guarantee.
const MIN_UPDATE_GAP_MS = 60 * 1000

export function ServiceWorkerUpdater() {
  const registrationRef = useRef<ServiceWorkerRegistration | null>(null)
  const lastUpdateRef = useRef(0)
  const shownRef = useRef(false)

  const {
    needRefresh: [needRefresh, setNeedRefresh],
    updateServiceWorker,
  } = useRegisterSW({
    onRegisteredSW(_swUrl, registration) {
      if (!registration) return
      registrationRef.current = registration
    },
    onRegisterError(error) {
      console.error('Service worker registration failed', error)
    },
  })

  useEffect(() => {
    const checkForUpdates = () => {
      const registration = registrationRef.current
      if (!registration || registration.installing || !navigator.onLine) return
      const now = Date.now()
      if (now - lastUpdateRef.current < MIN_UPDATE_GAP_MS) return
      lastUpdateRef.current = now
      void registration.update()
    }

    const interval = setInterval(checkForUpdates, UPDATE_INTERVAL_MS)
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') checkForUpdates()
    }
    document.addEventListener('visibilitychange', onVisibilityChange)

    return () => {
      clearInterval(interval)
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [])

  useEffect(() => {
    if (!needRefresh || shownRef.current) return
    shownRef.current = true
    toast.info('A new version of FortyMM is ready.', {
      id: TOAST_ID,
      description: 'Reload to get the latest update.',
      duration: Infinity,
      action: {
        label: 'Reload',
        onClick: () => {
          void updateServiceWorker(true)
        },
      },
      onDismiss: () => {
        shownRef.current = false
        setNeedRefresh(false)
      },
    })
  }, [needRefresh, setNeedRefresh, updateServiceWorker])

  return null
}
