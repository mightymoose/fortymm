import {
  HeadContent,
  Outlet,
  createRootRouteWithContext,
} from '@tanstack/react-router'
import type { QueryClient } from '@tanstack/react-query'
import { TanStackRouterDevtools } from '@tanstack/react-router-devtools'
import { ServiceWorkerUpdater } from '@/components/service-worker-updater'
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
  return (
    <>
      <HeadContent />
      <Outlet />
      <ServiceWorkerUpdater />
      <TanStackRouterDevtools />
    </>
  )
}
