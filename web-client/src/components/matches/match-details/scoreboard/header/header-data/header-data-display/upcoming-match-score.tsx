import type { HeaderSide } from '../header-data-query'
import { MatchScoreSlot } from './match-score-slot'
import { Participant } from '../../../participant'

export interface UpcomingMatchScoreProps {
  sides: HeaderSide[]
}

export const UpcomingMatchScore = ({ sides }: UpcomingMatchScoreProps) => {
  const [left, right] = sides

  return (
    <div className="md-hero__row" role="group" aria-label="Match score">
      <Participant size="hero" align="l" username={left.username} />
      <MatchScoreSlot>
        <span className="md-hero__vs-label">VS</span>
      </MatchScoreSlot>
      <Participant size="hero" align="r" username={right.username} />
    </div>
  )
}
