import type { StatusView } from '@/components/matches/match-status-badge'
import type { GameScore, HeaderSide } from '../header-data-query'
import { UpcomingMatchScore } from './upcoming-match-score'
import { PlayedMatchScore } from './played-match-score'

export interface MatchScoreProps {
  status: StatusView
  sides: HeaderSide[]
  games: GameScore[][]
  bestOf: number
}

export const MatchScore = ({ status, sides, games, bestOf }: MatchScoreProps) => {
  // Only a not-yet-started (pending) match is upcoming: show "VS" rather than a
  // score. A live match with no completed game yet still shows a score (0 – 0),
  // matching its "Live · Game N" badge. Branching on games.length would wrongly
  // render "VS" for the normal pre-first-game state of every live match.
  const isUpcoming = status.kind === 'upcoming'

  return isUpcoming ? (
    <UpcomingMatchScore sides={sides} />
  ) : (
    <PlayedMatchScore sides={sides} games={games} bestOf={bestOf} />
  )
}
