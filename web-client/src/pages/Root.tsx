import { Outlet, useRouteContext, useRouterState } from '@tanstack/react-router'
import { ToastProvider } from '../components/ToastProvider'
import { TooltipProvider } from '../components/TooltipProvider'
import { parseNetwork } from '../scoring/demoServer'
import { useAppSync } from '../scoring/sync'
import { UpdateNotice } from './UpdateNotice'

export function Root() {
  const { appUpdate } = useRouteContext({ from: '__root__' })
  const network = useRouterState({
    select: (state) => parseNetwork((state.location.search as { network?: unknown }).network),
  })
  useAppSync(network)
  return (
    <ToastProvider pinned={<UpdateNotice appUpdate={appUpdate} />}>
      <TooltipProvider>
        <Outlet />
      </TooltipProvider>
    </ToastProvider>
  )
}
