import { Suspense } from 'react'

import { RecentMatchesFetcher } from './recent-matches/recent-matches-fetcher'
import { RecentMatchesSkeleton } from './recent-matches/recent-matches-skeleton'

export interface RecentMatchesProps {
  playerId: string
}

/**
 * The profile's **Recent matches** card: the six matches the profile bundle
 * already carries, and a "View all N matches" link to the full paginated history
 * at `/players/$userId/matches`.
 *
 * Like the hero's cards it owns a `<Suspense>` with a hand-mirrored skeleton and
 * deliberately **no** error boundary: every card on the profile projects off the
 * same bundle query, so a failure means none of them has anything to draw and it
 * belongs to the route's `PlayerRouteError`.
 */
export function RecentMatches({ playerId }: RecentMatchesProps) {
  return (
    <Suspense fallback={<RecentMatchesSkeleton />}>
      <RecentMatchesFetcher playerId={playerId} />
    </Suspense>
  )
}
