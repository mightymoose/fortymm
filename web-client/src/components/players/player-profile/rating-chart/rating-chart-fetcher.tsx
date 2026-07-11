import { keepPreviousData, useQuery, useSuspenseQuery } from '@tanstack/react-query'
import { useMemo } from 'react'

import {
  DEFAULT_RATING_RANGE,
  ratingHistoryQueryOptions,
  type RatingRange,
} from '@/api/players'

import { RatingChartDisplay } from './rating-chart-fetcher/rating-chart-display'
import { ratingChartGateQuery } from './rating-chart-fetcher/rating-chart-gate-query'
import { selectRatingChart } from './rating-chart-fetcher/rating-chart-query'
import { UnratedPanel } from './rating-chart-fetcher/unrated-panel'

export interface RatingChartFetcherProps {
  playerId: string
  /** The ladder the chart is about (ADR-0915) — a rating is never a fact about a
   * player "in general". Part of both this card's key and the bundle's. */
  leagueId?: string
  /** The calendar window, from the profile's `?range=`. `undefined` is the
   * **default** (90 days), which is what a URL with no param means. */
  range?: RatingRange
}

/**
 * The chart's fetcher — and the one place on this page where the data flow is
 * different from every other card. Three things it does, each deliberate.
 *
 * **It owns a query instead of projecting off the bundle.** A range flip must
 * fetch *only* the range (ADR-0915), so the chart is keyed on the range and the
 * six other cards are not: they go on reading the bundle entry they already have,
 * unmoved, while one narrow request goes out for the new window.
 *
 * **Its first paint still costs nothing, and this card does nothing to arrange
 * that.** The bundle's `queryFn` writes its embedded `rating_history` straight
 * into this query's cache, under the key for the range *it* requested (see
 * `playerByIdQueryOptions`), so by the time the gate below has resolved the window
 * is already here and `useQuery` simply reads it.
 *
 * It is deliberately not done from this end. Seeding here would mean reading
 * `rating_history` out of the **cached** bundle — and a cached bundle's window
 * belongs to whichever range last fetched it, which is not necessarily the range
 * this card is showing (the range is not in the bundle's key, precisely so that a
 * flip doesn't refetch it). That is how a 30-day line ends up drawn under a
 * "90d" caption, stamped fresh, with no request left to correct it. The fetch
 * knows what it asked for; the cache does not.
 *
 * **It is `useQuery`, not `useSuspenseQuery`, and that is load-bearing.**
 * `useSuspenseQuery` structurally cannot do two things this card needs: it always
 * throws to the nearest boundary (there is no `throwOnError: false` for it), and a
 * key change re-suspends it to its skeleton. But a failed range flip must fail
 * *inside the card* — blanking a fully-painted profile because someone clicked
 * "30d" would be absurd — and a pending one must keep the old chart on screen
 * (`placeholderData: keepPreviousData`) rather than blink to a skeleton.
 *
 * The **gate** is the exception that proves the rule: whether this player has a
 * rating at all is a fact about the *player*, not the window, so it comes off the
 * bundle by projection, suspends with the rest of the page, and — when the answer
 * is no — means the rating-history request is never made at all.
 */
export function RatingChartFetcher({
  playerId,
  leagueId,
  range,
}: RatingChartFetcherProps) {
  const { data: gate } = useSuspenseQuery(
    ratingChartGateQuery(playerId, leagueId, range),
  )

  const history = useQuery({
    // No `initialData`: the window for the range this page loaded with is already
    // in the cache, put there by the bundle's own fetch. A range this card has
    // never shown finds nothing, and fetches — which is exactly right, and is the
    // worst this design degrades to: one narrow request, never a wrong line.
    ...ratingHistoryQueryOptions(playerId, { leagueId, range }),
    // Hold the previous range's line while the new one loads. The chart never
    // blanks — a flip redraws, it doesn't reload.
    placeholderData: keepPreviousData,
    // The card fails in place. The other six share the bundle's query and throw
    // to the route's boundary; this one renders "Couldn't load that range · Try
    // again" where the SVG goes and leaves the painted page alone.
    throwOnError: false,
    // An unrated player has no timeline to draw: don't go and ask for one.
    enabled: gate.isRated,
  })

  const chart = useMemo(
    () => (history.data ? selectRatingChart(history.data, range) : null),
    [history.data, range],
  )

  if (!gate.isRated) return <UnratedPanel />

  return (
    <RatingChartDisplay
      playerId={playerId}
      range={range ?? DEFAULT_RATING_RANGE}
      chart={chart}
      isError={history.isError}
      // `isPlaceholderData` is the honest test for "this line is the *previous*
      // range's": a background refetch of the range you are already looking at is
      // not a reason to caption the card as loading.
      isLoadingRange={history.isPlaceholderData || history.isPending}
      onRetry={() => void history.refetch()}
    />
  )
}
