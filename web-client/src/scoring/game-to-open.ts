import { isDecided, savedScore, type BestOf, type Games } from './scoring.ts'

// Which game the scoring page at /matches/$matchId/games/$gameId/scores/edit
// opens, for its route's loader (routes/matches/$matchId/games/$gameId/
// scores/edit.tsx), which turns the answer into the router's notFound() or
// redirect(). Pure: it reads only the match it is given.
// - open: the game is a saved game (any time, even once the match is
//   decided: a decided match stays editable) or an empty game of a match not
//   yet decided, in any order (game 3 before game 2).
// - not-found: `gameId` is not a game number, 1 to best of, written plainly
//   ("2", not "02" or "2.0").
// - decided: an empty game of a decided match, which can't be played; the
//   person goes to the dashboard.
export type GameToOpen =
  | { status: 'open'; game: number }
  | { status: 'not-found' }
  | { status: 'decided' }

export function gameToOpen(
  gameId: string,
  { bestOf, games }: { bestOf: BestOf; games: Games },
): GameToOpen {
  if (!/^[1-9]\d*$/.test(gameId)) return { status: 'not-found' }
  const game = Number(gameId)
  if (game > bestOf) return { status: 'not-found' }
  if (savedScore(games, game) === null && isDecided(games, bestOf)) return { status: 'decided' }
  return { status: 'open', game }
}
