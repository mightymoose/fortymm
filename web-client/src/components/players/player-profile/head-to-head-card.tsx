import { Suspense } from 'react'

import type { RatingRange } from '@/api/players'

import { HeadToHeadCardFetcher } from './head-to-head-card/head-to-head-card-fetcher'
import { HeadToHeadCardSkeleton } from './head-to-head-card/head-to-head-card-skeleton'

export interface HeadToHeadCardProps {
  playerId: string
  /** The ladder the profile's *bundle* is about (ADR-0915), from its `?league=`.
   * Nothing this card shows varies with it — a meeting is a decided match in any
   * league — but it is part of the bundle's query key, so every card on the page
   * must be handed the same one or the profile forks into two requests. */
  leagueId?: string
  /** The chart's calendar window (ADR-0915), from the profile's `?range=`.
   * `undefined` is the **default** window — the URL carries no param for it.
   *
   * It is **not** in the bundle's cache key (a range flip must not refetch the
   * bundle, or a failed flip would blank the page), but it *is* in the bundle's
   * request: the response embeds that window, and the chart seeds its own cache
   * from it. So every card must be handed the same range — whichever card's query
   * happens to trigger the shared fetch decides which window comes back in it. */
  range?: RatingRange
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
export function HeadToHeadCard({ playerId, leagueId, range }: HeadToHeadCardProps) {
  return (
    <Suspense fallback={<HeadToHeadCardSkeleton />}>
      <HeadToHeadCardFetcher
        playerId={playerId}
        leagueId={leagueId}
        range={range}
      />
    </Suspense>
  )
}
