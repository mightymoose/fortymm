import { NewMatchScreen, type NewMatch as Match } from './NewMatchScreen.tsx'

// What starting a match does: nothing yet. The form is UI only; storing the
// match on this device (a match store's action, then the match's page) comes
// with the tasks that build them.
function startMatch(_match: Match) {}

// /matches/new: the new match screen, with what its Start match does. When
// matches are kept on this device, this becomes the connected component
// around the screen (web-client/CLAUDE.md), handing it the store's action.
export function NewMatch() {
  return <NewMatchScreen onSubmit={startMatch} />
}
