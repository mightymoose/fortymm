import { Outlet, useRouteContext } from '@tanstack/react-router'
import { useCallback } from 'react'
import { sessionQuery } from '../api/queries'
import { ToastProvider } from '../components/ToastProvider'
import { TooltipProvider } from '../components/TooltipProvider'
import { useAppSync } from '../scoring/sync'
import { UpdateNotice } from './UpdateNotice'

export function Root() {
  const { api, appUpdate, queryClient } = useRouteContext({ from: '__root__' })
  // A board refused for want of a session or a permission means the
  // session may be out of date. A refresh already on its way is left to
  // land, as dropping it drops its cookie and starts another account.
  const refreshSession = useCallback(
    () =>
      void queryClient.invalidateQueries({ queryKey: sessionQuery(api).queryKey }, { cancelRefetch: false }),
    [api, queryClient],
  )
  useAppSync(api, refreshSession)
  return (
    <ToastProvider pinned={<UpdateNotice appUpdate={appUpdate} />}>
      <TooltipProvider>
        <Outlet />
      </TooltipProvider>
    </ToastProvider>
  )
}
