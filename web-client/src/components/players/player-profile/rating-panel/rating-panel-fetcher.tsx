import { useSuspenseQuery } from '@tanstack/react-query'

import type { RatingRange } from '@/api/players'

import { RatingPanelDisplay } from './rating-panel-fetcher/rating-panel-display'
import { ratingPanelQuery } from './rating-panel-fetcher/rating-panel-query'

export interface RatingPanelFetcherProps {
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

/** Thin fetcher: reads the standing view off the profile bundle's shared cache
 * entry — the very same entry the hero's identity card reads — and hands it to
 * the display. */
export function RatingPanelFetcher({ playerId, leagueId, range }: RatingPanelFetcherProps) {
  const { data: standing } = useSuspenseQuery(ratingPanelQuery(playerId, leagueId, range))

  return <RatingPanelDisplay standing={standing} />
}
