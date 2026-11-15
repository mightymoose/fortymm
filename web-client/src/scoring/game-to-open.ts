import { nextGame, type BestOf, type Score } from './scoring.ts'

// Which game the scoring page at /matches/$matchId/games/$gameId/scores/edit
// opens, for its route's loader (routes/matches/$matchId/games/$gameId/
// scores/edit.tsx), which turns the answer into the router's notFound() or
// redirect(). Pure: it reads only the match it is given.
// - open: the game is a saved game (any time, even once the match is
//   decided: a decided match stays editable) or the first unscored one.
// - not-found: `gameId` is not a game number, 1 to best of, written plainly
//   ("2", not "02" or "2.0").
// - next: an unscored game past the first unscored one; open that one
//   instead (`game`), or, when the match is decided and has no next game,
//   `game` is null and the person goes to the dashboard.
export type GameToOpen =
  | { status: 'open'; game: number }
  | { status: 'not-found' }
  | { status: 'next'; game: number | null }

export function gameToOpen(
  gameId: string,
  { bestOf, games }: { bestOf: BestOf; games: readonly Score[] },
): GameToOpen {
  if (!/^[1-9]\d*$/.test(gameId)) return { status: 'not-found' }
  const game = Number(gameId)
  if (game > bestOf) return { status: 'not-found' }
  if (game <= games.length) return { status: 'open', game }
  const next = nextGame(games, bestOf)
  return game === next ? { status: 'open', game } : { status: 'next', game: next }
}
