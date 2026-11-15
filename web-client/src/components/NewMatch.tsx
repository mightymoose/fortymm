import { useNavigate } from '@tanstack/react-router'
import { myMatchesStore } from '../stores/my-matches.ts'
import { NewMatchScreen } from './new-match/NewMatchScreen.tsx'

// The new match page (/matches/new), connected to the match list's store
// (src/stores/my-matches.ts).
//
// Start match keeps the match on this device and, the moment the store
// answers, opens game 1's scoring page in place of this one: Back from it
// doesn't return to a filled form, and it gets past the screen's leave guard,
// since a submitted form is still dirty. A create the store refuses (only
// the device's storage can) stays on the form, as filled, showing nothing:
// the screen has no error state.
export function NewMatch() {
  const navigate = useNavigate()
  return (
    <NewMatchScreen
      onSubmit={(match) => {
        void myMatchesStore
          .getState()
          .createMatch(match)
          .then((result) => {
            if (!result.ok) return
            void navigate({
              to: '/matches/$matchId/games/$gameId/scores/edit',
              params: { matchId: result.matchId, gameId: '1' },
              replace: true,
              ignoreBlocker: true,
            })
          })
      }}
    />
  )
}
