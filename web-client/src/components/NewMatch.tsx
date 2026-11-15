import { useUser } from '../stores/user.ts'
import { NewMatchScreen, type NewMatch as Match } from './NewMatchScreen.tsx'

// What starting a match does: nothing yet. The form is UI only; storing the
// match on this device (a match store's action, then the match's page) comes
// with the tasks that build them.
function startMatch(_match: Match) {}

// /matches/new, connected to the user store (src/stores/user.ts) for the
// card's "You": this device's username once the store has read one, as the
// top bar's mark does (the store is read at app startup, so the route needs
// no loader). Start match does nothing yet; when matches are kept on this
// device, it is a match store's action.
export function NewMatch() {
  const user = useUser()
  return (
    <NewMatchScreen
      you={user.state === 'user' ? { username: user.user.username } : null}
      onSubmit={startMatch}
    />
  )
}
