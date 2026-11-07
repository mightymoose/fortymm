import { Outlet, useRouteContext } from '@tanstack/react-router'
import { useCallback } from 'react'
import { sessionQuery } from '../api/queries'
import { ToastProvider } from '../components/ToastProvider'
import { TooltipProvider } from '../components/TooltipProvider'
import { useAppSync } from '../scoring/sync'
import { UpdateNotice } from './UpdateNotice'

export function Root() {
  const { api, appUpdate, queryClient } = useRouteContext({ from: '__root__' })
  // A board refused for want of permission means the session's permissions
  // may be out of date.
  const refreshSession = useCallback(
    () => void queryClient.invalidateQueries({ queryKey: sessionQuery(api).queryKey }),
    [api, queryClient],
  )
  useAppSync(refreshSession)
  return (
    <ToastProvider pinned={<UpdateNotice appUpdate={appUpdate} />}>
      <TooltipProvider>
        <Outlet />
      </TooltipProvider>
    </ToastProvider>
  )
}
