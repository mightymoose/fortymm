import { finished, type MatchDetail } from '../pages/matches/browse/match'
import type { GamePoints } from './board'
import { draftHash } from './fragment'
import { apiMatch } from './matches'

// Where Keep score opens a match the API knows, when this device has no
// fragment for it: the first game with no score, and a draft of the
// server's games, as Start would have built it. A pending result's draft
// names it in `replaces`, so the other side's approval of the correction
// is taken, not refused as stale. A final match opens nowhere, and nor
// does one whose players were merged into one, as no result can name the
// same player on both sides.
export function keepScoreTarget(match: MatchDetail, issuedAt: number): { gameNumber: string; hash: string } | null {
  const { status } = match
  if (status.kind === 'final' || match.players[0].id === match.players[1].id) return null
  // A board may hold a game in play, and a fragment holds only final scores.
  const end = match.games.findIndex((game) => !finished(game))
  const games: GamePoints[] = match.games
    .slice(0, end === -1 ? undefined : end)
    .slice(0, match.bestOf)
    .map(([left, right]) => [left, right])
  const replaces = status.kind === 'awaiting' || status.kind === 'disputed' ? match.resultHash : null
  const scoring = apiMatch(match.id, match.bestOf, match.rated, [match.players[0].id, match.players[1].id])
  return {
    gameNumber: String(Math.min(games.length + 1, match.bestOf)),
    hash: draftHash(scoring, games, replaces, issuedAt),
  }
}
