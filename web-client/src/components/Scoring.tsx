import { useNavigate } from '@tanstack/react-router'
import { useNewVersion } from '../new-version.ts'
import { gameToOpen } from '../scoring/game-to-open.ts'
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
// on the page, which then shows that game empty. The store's answer to
// either goes back to the screen, which shows one refused (by the device,
// or by the rules on the match as kept) and goes nowhere. Whether a new
// version is waiting (src/new-version.ts) goes to it too.
export function Scoring({ matchId, game }: { matchId: string; game: number }) {
  const entry = useMatch(matchId)
  const navigate = useNavigate()
  const newVersion = useNewVersion()
  if (entry?.status !== 'ready') return null
  // Only a game the route's guard opens: the match can become readable (a
  // read again, after the device refused) before the route's loader has
  // asked, and has turned another game into not found or the dashboard.
  if (gameToOpen(String(game), entry.match).status !== 'open') return null
  const { bestOf, games } = entry.match
  // A fresh screen for each match: the router keeps this page mounted when
  // only the match in the URL changes (Back from another match's game), and
  // nothing typed or refused on one match may stay for another.
  return (
    <ScoringScreen
      key={matchId}
      bestOf={bestOf}
      games={games}
      game={game}
      newVersion={newVersion}
      gameLink={(n) => ({
        to: '/matches/$matchId/games/$gameId/scores/edit',
        params: { matchId, gameId: String(n) },
      })}
      onSave={async (n, score) => {
        const result = await matchStore.getState().setGameScore(matchId, n, score)
        const saved = matchStore.getState().matches[matchId]
        if (result.ok && saved?.status === 'ready') {
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
        }
        return result
      }}
      onClear={(n) => matchStore.getState().clearGameScore(matchId, n)}
    />
  )
}
