import { useNavigate } from '@tanstack/react-router'
import { useNewVersion } from '../new-version.ts'
import { matchesStore } from '../stores/matches.ts'
import { NewMatchScreen } from './new-match/NewMatchScreen.tsx'

// The new match page (/matches/new), connected to the match list's store
// (src/stores/matches.ts).
//
// Start match keeps the match on this device and, the moment the store
// answers, opens game 1's scoring page in place of this one: Back from it
// doesn't return to a filled form, and it gets past the screen's leave guard,
// since a submitted form is still dirty. The store's answer goes back to the
// screen, which shows a create the device refused, on the form as filled.
// Whether a new version is waiting (src/new-version.ts) goes to it too.
export function NewMatch() {
  const navigate = useNavigate()
  const newVersion = useNewVersion()
  return (
    <NewMatchScreen
      newVersion={newVersion}
      onSubmit={async (match) => {
        const result = await matchesStore.getState().createMatch(match)
        if (result.ok) {
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
