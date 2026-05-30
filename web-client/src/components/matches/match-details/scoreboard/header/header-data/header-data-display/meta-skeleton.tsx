import { MatchStatusBadgeSkeleton } from '@/components/matches/match-status-badge-skeleton'
import { Skeleton } from '@/components/ui/skeleton'

export function MetaSkeleton() {
  return (
    <div className="md-hero__strip" aria-busy="true" data-testid="header-skeleton">
      <div className="md-hero__strip-l">
        <MatchStatusBadgeSkeleton />
      </div>
      <div className="md-hero__strip-r">
        <Skeleton className="h-4 w-28" />
        <Skeleton className="h-4 w-24" />
      </div>
    </div>
  )
};
