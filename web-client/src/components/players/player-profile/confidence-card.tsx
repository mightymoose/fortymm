import { Suspense } from 'react'

import type { RatingRange } from '@/api/players'

import { ConfidenceCardFetcher } from './confidence-card/confidence-card-fetcher'
import { ConfidenceCardSkeleton } from './confidence-card/confidence-card-skeleton'

export interface ConfidenceCardProps {
  playerId: string
  /** The ladder this card's numbers are about (ADR-0915), from the profile's
   * `?league=`. `undefined` is the **default league** — the URL carries no param
   * for it. It is part of the bundle's query key, so every card on the page must
   * be handed the same one or the profile forks into two requests. */
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
 * The profile's **Rating confidence** card: how settled this player's rating is,
 * and what range they might really be in (`CONTEXT.md` § *Rating confidence*) —
 * off the confidence block the profile bundle already carries.
 *
 * Like the other cards it owns a `<Suspense>` with a hand-mirrored skeleton and
 * deliberately **no** error boundary: every card on the profile projects off the
 * same bundle query, so a failure means none of them has anything to draw and it
 * belongs to the route's `PlayerRouteError`.
 *
 * Unlike the other cards, it can resolve to **nothing**. A player who has never
 * finished a rated match has no rating, so there is nothing to be confident about
 * and the fetcher renders `null` — the hero already says "Unrated". Mount it
 * unconditionally; it decides for itself whether it exists.
 */
export function ConfidenceCard({ playerId, leagueId, range }: ConfidenceCardProps) {
  return (
    <Suspense fallback={<ConfidenceCardSkeleton />}>
      <ConfidenceCardFetcher
        playerId={playerId}
        leagueId={leagueId}
        range={range}
      />
    </Suspense>
  )
}
