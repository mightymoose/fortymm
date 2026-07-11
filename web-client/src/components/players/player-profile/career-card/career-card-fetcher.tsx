import { useSuspenseQuery } from '@tanstack/react-query'

import type { RatingRange } from '@/api/players'

import { CareerCardDisplay } from './career-card-fetcher/career-card-display'
import { careerCardQuery } from './career-card-fetcher/career-card-query'

export interface CareerCardFetcherProps {
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

/** Thin fetcher: reads the career view off the profile bundle's shared cache
 * entry — the very same entry the hero and the Recent-matches card read — and
 * hands it to the display. No second request: the bundle already carries the
 * career block.
 *
 * It takes a player id and nothing else. Career is cross-league (ADR-0915), so
 * there is deliberately no league to thread through here. */
export function CareerCardFetcher({ playerId, leagueId, range }: CareerCardFetcherProps) {
  const { data: career } = useSuspenseQuery(careerCardQuery(playerId, leagueId, range))

  return <CareerCardDisplay career={career} />
}
