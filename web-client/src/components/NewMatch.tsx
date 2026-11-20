import { useNavigate } from '@tanstack/react-router'
import { useEffect, useRef } from 'react'
import { useNewVersion } from '../new-version.ts'
import { matchesStore } from '../stores/matches.ts'
import { NewMatchScreen } from './new-match/NewMatchScreen.tsx'

// The new match page (/matches/new), connected to the match list's store
// (src/stores/matches.ts).
//
// Start match keeps the match on this device and, the moment the store
// answers, opens game 1's scoring page in place of this one: Back from it
// doesn't return to a filled form, and it gets past the screen's leave guard,
// since a submitted form is still dirty. Only while the person is still on
// this page: one who left while the match was being kept stays where they
// went (the match is kept, and in the list). The store's answer goes back to
// the screen, which shows a create the device refused, on the form as
// filled. Whether a new version is waiting (src/new-version.ts) goes to it
// too.
export function NewMatch() {
  const navigate = useNavigate()
  const newVersion = useNewVersion()
  const left = useRef(false)
  useEffect(() => {
    left.current = false
    return () => {
      left.current = true
    }
  }, [])
  return (
    <NewMatchScreen
      newVersion={newVersion}
      onSubmit={async (match) => {
        const result = await matchesStore.getState().createMatch(match)
        if (result.ok && !left.current) {
          void navigate({
            to: '/matches/$matchId/games/$gameId/scores/edit',
            params: { matchId: result.matchId, gameId: '1' },
            replace: true,
            ignoreBlocker: true,
          })
        }
        return result
      }}
    />
  )
}
