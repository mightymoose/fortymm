import { useEffect } from 'react'
import { useNewVersion } from '../new-version.ts'
import { matchesStore, useMatches } from '../stores/matches.ts'
import {
  MatchListScreen,
  MatchListScreenPending,
  MatchListScreenUnavailable,
} from './match-list/MatchListScreen.tsx'

// /matches, connected to the match list store (src/stores/matches.ts): this
// device's matches, newest first, watched while the page is mounted, so a
// match kept meanwhile shows with no reload. The route's loader has read the
// list before this mounts; the pending view is for a list not read yet. A
// list the device wouldn't read says so, and its Try again is the store's
// load (the store also reads it again when the page is shown again).
export function MatchList() {
  const matches = useMatches()
  const newVersion = useNewVersion()
  useEffect(() => matchesStore.getState().watchMatches(), [])
  switch (matches.status) {
    case 'ready':
      return <MatchListScreen matches={matches.matches} />
    case 'unavailable':
      return (
        <MatchListScreenUnavailable
          reason={matches.reason}
          newVersion={newVersion}
          onRetry={() => matchesStore.getState().load()}
        />
      )
    case 'unread':
      return <MatchListScreenPending />
  }
}
