import type { GameScore, HeaderSide } from '../header-data-query'
import { UpcomingMatchScore } from './upcoming-match-score'
import { PlayedMatchScore } from './played-match-score'

export interface MatchScoreProps {
  sides: HeaderSide[]
  games: GameScore[][]
  bestOf: number
}

export const MatchScore = ({ sides, games, bestOf }: MatchScoreProps) => {
  // A match with no games played yet is upcoming: show "VS" rather than a score.
  const isUpcoming = games.length === 0

  return isUpcoming ? (
    <UpcomingMatchScore sides={sides} />
  ) : (
    <PlayedMatchScore sides={sides} games={games} bestOf={bestOf} />
  )
}
