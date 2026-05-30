import { Skeleton } from '@/components/ui/skeleton'
import { MatchScoreSlot } from './match-score-slot'

// Loading placeholder for <MatchScore />: mirrors the five-cell md-hero row
// (player · score · divider · score · player) so it reserves the same size and
// rearranges identically at the narrow breakpoint. The center slot keeps the
// score height reserved while the match data is in flight.
export const MatchScoreSkeleton = () => (
  <div className="md-hero__row">
    <div className="md-hero__player md-hero__player--l">
      <div className="md-hero__player-row">
        <Skeleton className="md-avatar md-hero__avatar-singles" />
        <div className="md-hero__player-text--l">
          <Skeleton className="h-5 w-28" />
        </div>
      </div>
    </div>

    <div className="md-hero__score md-hero__score--l">
      <Skeleton className="h-[0.7em] w-full" />
    </div>

    <MatchScoreSlot>
      <Skeleton className="h-4 w-8" />
    </MatchScoreSlot>

    <div className="md-hero__score md-hero__score--r">
      <Skeleton className="h-[0.7em] w-full" />
    </div>

    <div className="md-hero__player md-hero__player--r">
      <div className="md-hero__player-row">
        <Skeleton className="md-avatar md-hero__avatar-singles" />
        <div className="md-hero__player-text--l">
          <Skeleton className="h-5 w-28" />
        </div>
      </div>
    </div>
  </div>
)
