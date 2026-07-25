import { useEffect, type ReactNode } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { applyRealtimeEvent } from '@/api/realtime/apply'
import { createConnectResyncFilter } from '@/api/realtime/connect-resync'
import { openRealtimeConnection } from '@/api/realtime/connection'

/**
 * Holds the app's one `GET /v1/stream` connection open for as long as an
 * authenticated surface is mounted, and applies each pushed hint to the query
 * cache.
 *
 * **Mounted in `routes/_app/route.tsx`, around `<AppShell>` — not inside it.**
 * Two reasons, and they point the same way:
 *
 * - `_app`'s loader already `ensureQueryData`s the session, and the route does
 *   not render its children until that resolves, so the session cookie is
 *   guaranteed present before the first stream request. `/login`,
 *   `/confirm-email`, `/` and `/design-system` sit outside `_app` and must never
 *   open one.
 * - Putting it in `AppShell` would force an SSE handler into
 *   `app-shell.page.tsx` and into every page object that composes it, under
 *   vitest's `onUnhandledRequest: 'error'` — a network dependency inherited by
 *   dozens of component tests that have nothing to do with realtime.
 *
 * It renders its children and nothing else: there is no realtime UI, no
 * connection indicator, and deliberately no context. Nothing in the tree reads
 * from the stream — it writes to the cache, and the cache is the context.
 *
 * **The one hint it does not apply is this mount's own connect-time `resync`.**
 * Mounting is what opened the connection, and the page that mounted has already
 * fetched — so applying it would make every page load cost two reads of the same
 * endpoint. The filter is created inside the effect, so its scope is exactly one
 * run: later `resync`s (the server's ~15-minute recycle, a pub/sub recovery) are
 * a *reconnect's* reconciliation and still refetch. See
 * `api/realtime/connect-resync.ts` for why the run, and not the connection
 * attempt, is the signal.
 */
export function RealtimeProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient()

  useEffect(() => {
    const shouldApply = createConnectResyncFilter()
    const connection = openRealtimeConnection({
      onEvent: (event) => {
        if (shouldApply(event)) applyRealtimeEvent(queryClient, event)
      },
    })
    return () => connection.close()
  }, [queryClient])

  return <>{children}</>
}
