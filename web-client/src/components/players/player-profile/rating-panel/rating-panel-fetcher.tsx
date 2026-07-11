import { useSuspenseQuery } from '@tanstack/react-query'

import { RatingPanelDisplay } from './rating-panel-fetcher/rating-panel-display'
import { ratingPanelQuery } from './rating-panel-fetcher/rating-panel-query'

export interface RatingPanelFetcherProps {
  playerId: string
}

/** Thin fetcher: reads the standing view off the profile bundle's shared cache
 * entry — the very same entry the hero's identity card reads — and hands it to
 * the display. */
export function RatingPanelFetcher({ playerId }: RatingPanelFetcherProps) {
  const { data: standing } = useSuspenseQuery(ratingPanelQuery(playerId))

  return <RatingPanelDisplay standing={standing} />
}
