import { useEffect } from 'react'
import { matchesStore, useMatches } from '../stores/matches.ts'
import {
  MatchListScreen,
  MatchListScreenPending,
} from './match-list/MatchListScreen.tsx'

// /matches, connected to the match list store (src/stores/matches.ts): this
// device's matches, newest first, watched while the page is mounted, so a
// match kept meanwhile shows with no reload. The route's loader has read the
// list before this mounts; the pending view is for a list not read yet, and
// for storage refusing (`unavailable`, which only the real store gives; the
// screen has no state for it yet).
export function MatchList() {
  const matches = useMatches()
  useEffect(() => matchesStore.getState().watchMatches(), [])
  return matches.status === 'ready' ? (
    <MatchListScreen matches={matches.matches} />
  ) : (
    <MatchListScreenPending />
  )
}
