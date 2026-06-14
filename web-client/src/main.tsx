import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { RouterProvider, createRouter } from '@tanstack/react-router'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ReactQueryDevtools } from '@tanstack/react-query-devtools'
import { toast } from 'sonner'
import './index.css'
import { Toaster } from '@/components/ui/sonner'
import { NotFoundPage } from '@/components/not-found-page'
import { setSessionEndedHandler } from '@/api/client'
import { SESSION_QUERY_KEY } from '@/api/session'
import { clearAppEntered } from '@/lib/landing-redirect'
import { routeTree } from './routeTree.gen'

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

// When any request reports the session was merged away on another device, drop
// the stale session, flash the reason, and route to sign-in (email prefilled).
setSessionEndedHandler(({ message, email }) => {
  clearAppEntered()
  queryClient.removeQueries({ queryKey: SESSION_QUERY_KEY })
  toast.message(message)
  void router.navigate({ to: '/login', search: { email, error: undefined } })
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
    await unregisterServiceWorkers()
    return
  }
  if (import.meta.env.VITE_ENABLE_MSW === 'false') {
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
