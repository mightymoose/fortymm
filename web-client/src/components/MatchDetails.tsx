import { useMatch } from '../stores/match.ts'
import { MatchDetailsScreen } from './match-details/MatchDetailsScreen.tsx'

// The match details page (/matches/$matchId), connected to the match store
// (src/stores/match.ts). The match layout (Match.tsx) watches the match and
// its route's loader has read it before this mounts, so a change to the
// match, here or elsewhere, shows on the page. Score opens the scoring
// screen of the game the screen names as next.
export function MatchDetails({ matchId }: { matchId: string }) {
  const entry = useMatch(matchId)
  if (entry?.status !== 'ready') return null
  return (
    <MatchDetailsScreen
      match={entry.match}
      scoreLink={(game) => ({
        to: '/matches/$matchId/games/$gameId/scores/edit',
        params: { matchId, gameId: String(game) },
      })}
    />
  )
}
