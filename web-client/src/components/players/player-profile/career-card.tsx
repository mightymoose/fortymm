import { Suspense } from 'react'

import { CareerCardFetcher } from './career-card/career-card-fetcher'
import { CareerCardSkeleton } from './career-card/career-card-skeleton'

export interface CareerCardProps {
  playerId: string
  /** The ladder this card's numbers are about (ADR-0915), from the profile's
   * `?league=`. `undefined` is the **default league** — the URL carries no param
   * for it. It is part of the bundle's query key, so every card on the page must
   * be handed the same one or the profile forks into two requests. */
  leagueId?: string
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
export function CareerCard({ playerId, leagueId }: CareerCardProps) {
  return (
    <Suspense fallback={<CareerCardSkeleton />}>
      <CareerCardFetcher playerId={playerId} leagueId={leagueId} />
    </Suspense>
  )
}
