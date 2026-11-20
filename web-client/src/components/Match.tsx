import { Outlet, useRouter } from '@tanstack/react-router'
import { useCallback, useEffect, useState } from 'react'
import { useNewVersion } from '../new-version.ts'
import type { Unavailable } from '../stores/match-source.ts'
import { matchStore, useMatch } from '../stores/match.ts'
import { MatchUnavailableScreen } from './match/MatchUnavailableScreen.tsx'

// The layout of every page of one match (src/routes/matches/$matchId.tsx):
// the current page, in the router's <Outlet />, with the match store
// watching the match while it is mounted, so a change to the match, made on
// this page or elsewhere, shows on the page.
//
// While the device won't read the match (its entry `unavailable`: the
// loaders' read was refused; a later read refused leaves a match already
// read as it is, stores/match.ts), MatchUnavailableScreen takes the page's
// place. Reading it again is running the routes' loaders again
// (`router.invalidate()`), so a page's own guards (which game the scoring
// page may open) are asked too: by its Try again, and when the page is shown
// again (the person coming back to the tab), with no timer. It is never a
// refresh of a match already read; the store keeps that current. The page
// stays this one until the loaders, and any redirect a guard answers with,
// are done, so a page the guard turns away never shows on the way.
export function Match({ matchId }: { matchId: string }) {
  const entry = useMatch(matchId)
  const router = useRouter()
  const newVersion = useNewVersion()
  const unavailable = entry?.status === 'unavailable'
  // The reason the page can't be read, kept while a read again (Try again,
  // the page shown again) runs the loaders: the page shows that until they
  // have answered, so a guard that turns the page away (the scoring page's,
  // for an empty game of a match decided meanwhile) does so before any of
  // it shows.
  const [retrying, setRetrying] = useState<Unavailable['reason'] | null>(null)
  const retry = useCallback(
    (reason: Unavailable['reason']) => {
      setRetrying(reason)
      // `sync`: wait for the loaders themselves, and any redirect they
      // answer with, not only for the reload to start (a match already
      // read reloads in the background otherwise).
      return router.invalidate({ sync: true }).finally(() => setRetrying(null))
    },
    [router],
  )
  useEffect(() => matchStore.getState().watchMatch(matchId), [matchId])
  useEffect(() => {
    if (!unavailable) return
    const reason = entry.reason
    const shown = () => {
      if (document.visibilityState === 'visible') void retry(reason)
    }
    document.addEventListener('visibilitychange', shown)
    return () => document.removeEventListener('visibilitychange', shown)
  }, [unavailable, entry, retry])
  const reason = entry?.status === 'unavailable' ? entry.reason : retrying
  if (reason !== null) {
    return (
      <MatchUnavailableScreen
        reason={reason}
        newVersion={newVersion}
        onRetry={() => retry(reason)}
      />
    )
  }
  return <Outlet />
}
