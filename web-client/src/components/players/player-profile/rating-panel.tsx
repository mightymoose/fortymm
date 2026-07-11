import { Suspense } from 'react'

import { RatingPanelFetcher } from './rating-panel/rating-panel-fetcher'
import { RatingPanelSkeleton } from './rating-panel/rating-panel-skeleton'

export interface RatingPanelProps {
  playerId: string
}

/**
 * Where the player stands: rating, Δ, rank out of the ladder, peak and their
 * last ten results.
 *
 * Like the identity card it owns a `<Suspense>` with a hand-mirrored skeleton
 * and **no** error boundary — both cards project off the same bundle query, so a
 * failure belongs to the route, not to one card.
 */
export function RatingPanel({ playerId }: RatingPanelProps) {
  return (
    <Suspense fallback={<RatingPanelSkeleton />}>
      <RatingPanelFetcher playerId={playerId} />
    </Suspense>
  )
}
