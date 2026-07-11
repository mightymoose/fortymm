import { Suspense } from 'react'

import { HeadToHeadCardFetcher } from './head-to-head-card/head-to-head-card-fetcher'
import { HeadToHeadCardSkeleton } from './head-to-head-card/head-to-head-card-skeleton'

export interface HeadToHeadCardProps {
  playerId: string
  /** The ladder the profile's *bundle* is about (ADR-0915), from its `?league=`.
   * Nothing this card shows varies with it — a meeting is a decided match in any
   * league — but it is part of the bundle's query key, so every card on the page
   * must be handed the same one or the profile forks into two requests. */
  leagueId?: string
}

/**
 * The profile's **Head-to-head** card: on someone else's profile, *your* record
 * against them, and — if you have never met — an invitation to fix that
 * (ADR-0915). On your own, your frequent opponents; there is no playing yourself.
 *
 * Like the other cards it owns a `<Suspense>` with a hand-mirrored skeleton and
 * deliberately **no** error boundary: every card on the profile projects off the
 * same bundle query, so a failure means none of them has anything to draw and it
 * belongs to the route's `PlayerRouteError`.
 *
 * Unlike the confidence card, it always renders *something*. Even a player nobody
 * has ever met has a head-to-head card — it is the one that says so, and offers
 * the match that would end that.
 */
export function HeadToHeadCard({ playerId, leagueId }: HeadToHeadCardProps) {
  return (
    <Suspense fallback={<HeadToHeadCardSkeleton />}>
      <HeadToHeadCardFetcher playerId={playerId} leagueId={leagueId} />
    </Suspense>
  )
}
