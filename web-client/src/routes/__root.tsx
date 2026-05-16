import { useEffect } from 'react'
import {
  HeadContent,
  Outlet,
  createRootRouteWithContext,
  useRouterState,
} from '@tanstack/react-router'
import type { QueryClient } from '@tanstack/react-query'
import { TanStackRouterDevtools } from '@tanstack/react-router-devtools'
import { ServiceWorkerUpdater } from '@/components/service-worker-updater'
import { markAppEntered } from '@/lib/landing-redirect'
import { pageTitle } from '@/lib/page-title'

export interface RouterContext {
  queryClient: QueryClient
}

export const Route = createRootRouteWithContext<RouterContext>()({
  head: () => ({
    meta: [{ title: pageTitle() }],
  }),
  component: RootComponent,
})

function RootComponent() {
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  useEffect(() => {
    if (pathname !== '/') markAppEntered()
  }, [pathname])

  return (
    <>
      <HeadContent />
      <Outlet />
      <ServiceWorkerUpdater />
      <TanStackRouterDevtools />
    </>
  )
}
