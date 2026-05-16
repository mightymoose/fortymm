import {
  HeadContent,
  Outlet,
  createRootRouteWithContext,
} from '@tanstack/react-router'
import type { QueryClient } from '@tanstack/react-query'
import { TanStackRouterDevtools } from '@tanstack/react-router-devtools'
import { ServiceWorkerUpdater } from '@/components/service-worker-updater'

export interface RouterContext {
  queryClient: QueryClient
}

export const Route = createRootRouteWithContext<RouterContext>()({
  head: () => ({
    meta: [{ title: 'FortyMM' }],
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
