import { Outlet, createRootRoute } from '@tanstack/react-router'
import { TanStackRouterDevtools } from '@tanstack/react-router-devtools'
import { ServiceWorkerUpdater } from '@/components/service-worker-updater'

export const Route = createRootRoute({
  component: RootComponent,
})

function RootComponent() {
  return (
    <>
      <Outlet />
      <ServiceWorkerUpdater />
      <TanStackRouterDevtools />
    </>
  )
}
