import type { MatchDetails } from '@/api/matches'

import { matchDetailsQuery } from '../../../match-details-query'

// The line score shares the header's projected side/game shapes — those are the
// canonical contracts for a match's participants and per-game points.
export type { GameScore, HeaderSide } from '../../header/header-data/header-data-query'
import type { GameScore, HeaderSide } from '../../header/header-data/header-data-query'

export type LineScoreData = {
  bestOf: number
  sides: HeaderSide[]
  games: GameScore[][]
}

function toSides(data: MatchDetails): HeaderSide[] {
  return [...data.sides]
    .sort((a, b) => a.side_number - b.side_number)
    .map((side) => ({
      id: side.players[0]?.user_id ?? '',
      username: side.players[0]?.username ?? '',
    }))
}

function toGames(data: MatchDetails): GameScore[][] {
  return data.games.flatMap((game) =>
    game.score
      ? [
          [
            { sideNumber: 0, points: game.score.side_1_points },
            { sideNumber: 1, points: game.score.side_2_points },
          ],
        ]
      : [],
  )
}

export const lineScoreDataQuery = (matchId: string) => ({
  ...matchDetailsQuery(matchId),
  select: (data: MatchDetails): LineScoreData => ({
    bestOf: data.best_of,
    sides: toSides(data),
    games: toGames(data),
  }),
})
