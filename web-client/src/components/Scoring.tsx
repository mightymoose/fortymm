import { useNavigate } from '@tanstack/react-router'
import { nextGame } from '../scoring/scoring.ts'
import { matchStore, useMatch } from '../stores/match.ts'
import { ScoringScreen } from './scoring/ScoringScreen.tsx'

// The scoring page (/matches/$matchId/games/$gameId/scores/edit), connected
// to the match store (src/stores/match.ts); the match layout (Match.tsx)
// watches the match, and the route's loaders have read it before this mounts.
//
// A save the store takes moves on the moment it answers: to the lowest empty
// game, or to the dashboard once the match is decided (an edit that leaves
// it decided too), replacing this page and past the screen's leave guard,
// since a saved form is still dirty. A clear (any saved game, at once) stays
// on the page, which then shows that game empty. An action the store refuses
// (the screen checks the rules first, so it shouldn't be) changes nothing,
// shows nothing and goes nowhere.
export function Scoring({ matchId, game }: { matchId: string; game: number }) {
  const entry = useMatch(matchId)
  const navigate = useNavigate()
  if (entry?.status !== 'ready') return null
  const { bestOf, games } = entry.match
  return (
    <ScoringScreen
      bestOf={bestOf}
      games={games}
      game={game}
      gameLink={(n) => ({
        to: '/matches/$matchId/games/$gameId/scores/edit',
        params: { matchId, gameId: String(n) },
      })}
      onSave={(n, score) => {
        void matchStore
          .getState()
          .setGameScore(matchId, n, score)
          .then((result) => {
            const saved = matchStore.getState().matches[matchId]
            if (!result.ok || saved?.status !== 'ready') return
            const next = nextGame(saved.match.games, bestOf)
            void navigate(
              next === null
                ? { to: '/', replace: true, ignoreBlocker: true }
                : {
                    to: '/matches/$matchId/games/$gameId/scores/edit',
                    params: { matchId, gameId: String(next) },
                    replace: true,
                    ignoreBlocker: true,
                  },
            )
          })
      }}
      onClear={(n) => void matchStore.getState().clearGameScore(matchId, n)}
    />
  )
}
