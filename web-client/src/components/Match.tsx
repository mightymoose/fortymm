import { Outlet, useRouter } from '@tanstack/react-router'
import { useEffect } from 'react'
import { useNewVersion } from '../new-version.ts'
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
// refresh of a match already read; the store keeps that current.
export function Match({ matchId }: { matchId: string }) {
  const entry = useMatch(matchId)
  const router = useRouter()
  const newVersion = useNewVersion()
  const unavailable = entry?.status === 'unavailable'
  useEffect(() => matchStore.getState().watchMatch(matchId), [matchId])
  useEffect(() => {
    if (!unavailable) return
    const shown = () => {
      if (document.visibilityState === 'visible') void router.invalidate()
    }
    document.addEventListener('visibilitychange', shown)
    return () => document.removeEventListener('visibilitychange', shown)
  }, [unavailable, router])
  if (entry?.status === 'unavailable') {
    return (
      <MatchUnavailableScreen
        reason={entry.reason}
        newVersion={newVersion}
        onRetry={() => router.invalidate()}
      />
    )
  }
  return <Outlet />
}
