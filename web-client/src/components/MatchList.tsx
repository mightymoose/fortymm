import { MatchListScreen } from './match-list/MatchListScreen.tsx'
import { listedSampleMatches } from './match-list/sample-matches.ts'

// A match's page. A plain path, since its route (/matches/$matchId) is not
// on this branch yet: once it is, the screen takes the router's typed `to`
// and `params` instead.
function matchLink(id: string) {
  return `/matches/${encodeURIComponent(id)}`
}

// /matches: the matches list, showing the sample matches (sample data, to
// delete when the store is connected). When matches are kept on this device,
// this becomes the connected component around the screen
// (web-client/CLAUDE.md), handing it the store's matches.
export function MatchList() {
  return (
    <MatchListScreen matches={listedSampleMatches()} matchLink={matchLink} />
  )
}
