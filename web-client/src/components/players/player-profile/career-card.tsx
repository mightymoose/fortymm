import { Suspense } from 'react'

import { CareerCardFetcher } from './career-card/career-card-fetcher'
import { CareerCardSkeleton } from './career-card/career-card-skeleton'

export interface CareerCardProps {
  playerId: string
}

/**
 * The profile's **Career** card: the player's lifetime record across *every*
 * league they play in (`CONTEXT.md` § *Career*) — win rate, W–L, streaks and
 * games won, off the career block the profile bundle already carries.
 *
 * Like the other cards it owns a `<Suspense>` with a hand-mirrored skeleton and
 * deliberately **no** error boundary: every card on the profile projects off the
 * same bundle query, so a failure means none of them has anything to draw and it
 * belongs to the route's `PlayerRouteError`.
 */
export function CareerCard({ playerId }: CareerCardProps) {
  return (
    <Suspense fallback={<CareerCardSkeleton />}>
      <CareerCardFetcher playerId={playerId} />
    </Suspense>
  )
}
