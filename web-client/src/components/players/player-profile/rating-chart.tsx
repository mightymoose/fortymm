import { Suspense } from 'react'

import type { RatingRange } from '@/api/players'

import { RatingChartFetcher } from './rating-chart/rating-chart-fetcher'
import { RatingChartSkeleton } from './rating-chart/rating-chart-skeleton'

export interface RatingChartProps {
  playerId: string
  /** The ladder the chart is about (ADR-0915) — part of both this card's key and
   * the bundle's. `undefined` is the **default league**. */
  leagueId?: string
  /** The calendar window, from the profile's `?range=`. `undefined` is the
   * **default** (90 days) — the URL carries no param for it. */
  range?: RatingRange
}

/**
 * The profile's **rating chart**: where this player's rating has been over the
 * last 30 days / 90 days / year, on this ladder (ADR-0915).
 *
 * It is the one card on the page that does **not** project off the profile
 * bundle, and everything unusual about it follows from that one fact. A range
 * flip must fetch *only* the range — so the chart owns a query keyed on the range,
 * while the other six cards go on reading the bundle entry they already have. Its
 * first paint still costs nothing: the bundle embeds the window for the range the
 * page loaded with, and the fetcher seeds its cache from it.
 *
 * And because it owns a query, it owns an error state: a failed range flip renders
 * "Couldn't load that range · Try again" *inside* the card. The `<Suspense>` here
 * is for the **bundle** — the card still needs to know whether this player has a
 * rating at all before it can decide whether to exist.
 */
export function RatingChart({ playerId, leagueId, range }: RatingChartProps) {
  return (
    <Suspense fallback={<RatingChartSkeleton />}>
      <RatingChartFetcher
        playerId={playerId}
        leagueId={leagueId}
        range={range}
      />
    </Suspense>
  )
}
