import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { RouterProvider, createRouter } from '@tanstack/react-router'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ReactQueryDevtools } from '@tanstack/react-query-devtools'
import { toast } from 'sonner'
import './index.css'
import { Toaster } from '@/components/ui/sonner'
import { NotFoundPage } from '@/components/not-found-page'
import { readEndedSession, subscribeIdentityChange, subscribeSessionEnd } from '@/api/browser-session'
import { closeRealtimeConnections } from '@/api/realtime/connection'
import { handleIdentityChange } from '@/api/identity-change'
import { clearAppEntered } from '@/lib/landing-redirect'
import { initFaro } from '@/observability/faro'
import { routeTree } from './routeTree.gen'

// Start browser telemetry as early as possible so startup errors are captured.
// No-op unless VITE_FARO_COLLECTOR_URL is set (UAT build only).
void initFaro()

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: false,
    },
  },
})
const router = createRouter({
  routeTree,
  context: { queryClient },
  defaultNotFoundComponent: NotFoundPage,
  // Preload routes on link hover/touch (intent). Routes warm the React Query
  // cache in their loaders, so let React Query own staleness rather than the
  // router's own loader cache.
  defaultPreload: 'intent',
  defaultPreloadStaleTime: 0,
})

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}

// When any request reports the session has ended — merged away on another
// device, or signed out / expired — drop the stale session, flash the reason,
// and route to sign-in (email prefilled when the server knows it; the
// signed-out case has none). Never let the next bootstrap silently mint a fresh
// guest in the signed-out user's place.
//
// The sequence lives in `api/identity-change.ts`, shared with the deliberate
// sign-out path and with the sign-ins that can land on a different account,
// where its ORDER is testable — closing the realtime stream has to happen
// before the cache is cleared, and a step order written inline here could only
// ever be checked by reading it.
subscribeSessionEnd(() => {
  const info = readEndedSession()
  if (!info) return
  handleIdentityChange(
    {
      closeRealtime: closeRealtimeConnections,
      clearAppEntered,
      clearQueryCache: () => queryClient.clear(),
      notify: (message) => void toast.message(message),
      navigateToLogin: (email) =>
        void router.navigate({ to: '/login', search: { email, error: undefined } }),
    },
    info,
  )
})

subscribeIdentityChange(() => {
  if (readEndedSession()) return
  handleIdentityChange({
    closeRealtime: closeRealtimeConnections,
    clearQueryCache: () => {
      queryClient.removeQueries({ type: 'inactive' })
      // Keep mounted observers attached while dropping their old account data.
      void queryClient.resetQueries({ type: 'active' })
    },
  })
  if (['/login', '/login/verifying', '/confirm-email'].includes(router.state.location.pathname)) {
    void router.navigate({ to: '/dashboard', replace: true })
  } else {
    void router.invalidate()
  }
})

async function unregisterServiceWorkers() {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return
  try {
    const registrations = await navigator.serviceWorker.getRegistrations()
    await Promise.all(registrations.map((r) => r.unregister()))
  } catch {
    // ignore
  }
}

async function enableMocking() {
  if (!import.meta.env.DEV) {
    // Production never loads MSW, so there's nothing to clean up. Calling
    // unregisterServiceWorkers() here would evict the PWA worker on every
    // page load before React mounts, defeating the cache entirely.
    return
  }
  if (import.meta.env.VITE_ENABLE_MSW === 'false') {
    // Dev with MSW disabled (e.g. docker compose real-API mode): clear any
    // stale MSW worker left from a previous dev-server session.
    await unregisterServiceWorkers()
    return
  }
  const { worker } = await import('./mocks/browser')
  await worker.start({
    onUnhandledRequest: 'bypass',
  })
}

enableMocking().then(() => {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
        <Toaster closeButton position="top-right" />
        <ReactQueryDevtools initialIsOpen={false} />
      </QueryClientProvider>
    </StrictMode>,
  )
})
