import { useEffect, useRef } from 'react'
import { useRegisterSW } from 'virtual:pwa-register/react'
import { toast } from 'sonner'

const TOAST_ID = 'sw-update-available'

export function ServiceWorkerUpdater() {
  const {
    needRefresh: [needRefresh, setNeedRefresh],
    updateServiceWorker,
  } = useRegisterSW({
    onRegisteredSW(_swUrl, registration) {
      if (!registration) return
      const hourMs = 60 * 60 * 1000
      setInterval(() => {
        if (!registration.installing && navigator.onLine) {
          registration.update()
        }
      }, hourMs)
    },
    onRegisterError(error) {
      console.error('Service worker registration failed', error)
    },
  })

  const shownRef = useRef(false)

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
