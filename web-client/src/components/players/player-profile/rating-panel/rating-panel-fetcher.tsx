import { useSuspenseQuery } from '@tanstack/react-query'

import { RatingPanelDisplay } from './rating-panel-fetcher/rating-panel-display'
import { ratingPanelQuery } from './rating-panel-fetcher/rating-panel-query'

export interface RatingPanelFetcherProps {
  playerId: string
  /** The ladder this card's numbers are about (ADR-0915), from the profile's
   * `?league=`. `undefined` is the **default league** — the URL carries no param
   * for it. It is part of the bundle's query key, so every card on the page must
   * be handed the same one or the profile forks into two requests. */
  leagueId?: string
}

/** Thin fetcher: reads the standing view off the profile bundle's shared cache
 * entry — the very same entry the hero's identity card reads — and hands it to
 * the display. */
export function RatingPanelFetcher({ playerId, leagueId }: RatingPanelFetcherProps) {
  const { data: standing } = useSuspenseQuery(ratingPanelQuery(playerId, leagueId))

  return <RatingPanelDisplay standing={standing} />
}
