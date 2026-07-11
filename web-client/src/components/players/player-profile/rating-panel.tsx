import { Suspense } from 'react'

import { RatingPanelFetcher } from './rating-panel/rating-panel-fetcher'
import { RatingPanelSkeleton } from './rating-panel/rating-panel-skeleton'

export interface RatingPanelProps {
  playerId: string
  /** The ladder this card's numbers are about (ADR-0915), from the profile's
   * `?league=`. `undefined` is the **default league** — the URL carries no param
   * for it. It is part of the bundle's query key, so every card on the page must
   * be handed the same one or the profile forks into two requests. */
  leagueId?: string
}

/**
 * Where the player stands: rating, Δ, rank out of the ladder, peak and their
 * last ten results.
 *
 * Like the identity card it owns a `<Suspense>` with a hand-mirrored skeleton
 * and **no** error boundary — both cards project off the same bundle query, so a
 * failure belongs to the route, not to one card.
 */
export function RatingPanel({ playerId, leagueId }: RatingPanelProps) {
  return (
    <Suspense fallback={<RatingPanelSkeleton />}>
      <RatingPanelFetcher playerId={playerId} leagueId={leagueId} />
    </Suspense>
  )
}
