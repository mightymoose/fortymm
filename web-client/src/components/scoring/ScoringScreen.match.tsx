import { Link, useLocation, useNavigate } from '@tanstack/react-router'
import { useRef, useState } from 'react'
import { nextGame, withGame, type BestOf, type Games } from '../../scoring/scoring.ts'
import { ScoringScreen } from './ScoringScreen.tsx'

// For the scoring screen's tests only (ScoringScreen.page.tsx, renderMatch):
// a stand-in caller for a journey across games. It keeps the games, opens
// game n at the scoring page's path for game n of match `m` (where a
// scoreline cell links; the bare router renders the screen at any path), or
// else the next game to score, and after a save opens the next game to score
// (or `/` once the match is decided), past the screen's leave guard
// (`ignoreBlocker`). A clear stays. Beside the screen, a "Dashboard" link to
// `/` is a way out of scoring. The routes and the match store take its place
// in the app; the screen is the same.
export function Match({
  bestOf,
  games: saved,
}: {
  bestOf: BestOf
  games: Games
}) {
  const [games, setGames] = useState<Games>(saved)
  // The games as the last save left them, for the move on after it.
  const latest = useRef(games)
  const pathname = useLocation({ select: (location) => location.pathname })
  const navigate = useNavigate()
  const opened = /^\/matches\/m\/games\/(\d+)\/scores\/edit$/.exec(pathname)?.[1]
  const game = Number(opened ?? nextGame(games, bestOf) ?? 1)
  return (
    <>
      <Link to="/">Dashboard</Link>
      <ScoringScreen
        bestOf={bestOf}
        games={games}
        game={game}
        gameLink={(n) => ({
          to: '/matches/$matchId/games/$gameId/scores/edit',
          params: { matchId: 'm', gameId: String(n) },
        })}
        newVersion={{ waiting: false, reload: () => {} }}
        matchPage={{ to: '/matches/$matchId', params: { matchId: 'm' } }}
        onSave={async (n, score) => {
          latest.current = withGame(games, n, score)
          setGames(latest.current)
          return { ok: true }
        }}
        onSaved={() => {
          const after = nextGame(latest.current, bestOf)
          void navigate(
            after === null
              ? { to: '/', ignoreBlocker: true }
              : {
                  to: '/matches/$matchId/games/$gameId/scores/edit',
                  params: { matchId: 'm', gameId: String(after) },
                  ignoreBlocker: true,
                },
          )
        }}
        onClear={async (n) => {
          setGames(withGame(games, n, null))
          return { ok: true }
        }}
      />
    </>
  )
}
