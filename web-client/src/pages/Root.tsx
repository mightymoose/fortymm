import { Outlet, useRouteContext } from '@tanstack/react-router'
import { useCallback, useSyncExternalStore } from 'react'
import { sessionQuery } from '../api/queries'
import { ToastProvider } from '../components/ToastProvider'
import { TooltipProvider } from '../components/TooltipProvider'
import { useAppSync } from '../scoring/sync'
import { UpdateNotice } from './UpdateNotice'

export function Root() {
  const { api, appUpdate, queryClient } = useRouteContext({ from: '__root__' })
  // A board refused for want of a session or a permission means the
  // session may be out of date. The board can still be sending on a page
  // that doesn't read the session, such as /design-system, so the refresh
  // refetches it even with no observer.
  const refreshSession = useCallback(
    () =>
      void queryClient.invalidateQueries({
        queryKey: sessionQuery(api).queryKey,
        refetchType: 'all',
      }),
    [api, queryClient],
  )
  // Whether a page loaded the session. It reads the cache, so it starts no
  // session, and adds no observer, which the refresh above would skip as
  // disabled.
  const signedIn = useSyncExternalStore(
    (listener) => queryClient.getQueryCache().subscribe(listener),
    () => queryClient.getQueryData(sessionQuery(api).queryKey) !== undefined,
  )
  useAppSync(api, refreshSession, signedIn)
  return (
    <ToastProvider pinned={<UpdateNotice appUpdate={appUpdate} />}>
      <TooltipProvider>
        <Outlet />
      </TooltipProvider>
    </ToastProvider>
  )
}
