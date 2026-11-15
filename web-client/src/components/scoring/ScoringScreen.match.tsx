import { useLocation, useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import type { BestOf, Score } from '../../scoring/scoring.ts'
import { ScoringScreen } from './ScoringScreen.tsx'

// For the scoring screen's tests only (ScoringScreen.page.tsx, renderMatch):
// a stand-in caller for a journey across games. It keeps the games saved,
// opens game n at `#game-n` (where a scoreline cell links) or else the next
// game to score, and after a save opens the next game to score, past the
// screen's leave guard (`ignoreBlocker`). The routes and the match store
// take its place later; the screen is the same.
export function Match({
  opponentName,
  bestOf,
  games: saved,
}: {
  opponentName: string
  bestOf: BestOf
  games: Score[]
}) {
  const [games, setGames] = useState<readonly Score[]>(saved)
  const hash = useLocation({ select: (location) => location.hash })
  const navigate = useNavigate()
  const game = Number(/^game-(\d+)$/.exec(hash)?.[1] ?? games.length + 1)
  return (
    <ScoringScreen
      opponentName={opponentName}
      bestOf={bestOf}
      games={games}
      game={game}
      gameLink={(n) => ({ to: '/', hash: `game-${n}` })}
      onSave={(n, score) => {
        const next = n <= games.length ? games.with(n - 1, score) : [...games, score]
        setGames(next)
        void navigate({ to: '/', hash: `game-${next.length + 1}`, ignoreBlocker: true })
      }}
      onClear={(n) => setGames(games.slice(0, n - 1))}
    />
  )
}
