import { useSuspenseQuery } from '@tanstack/react-query'

import { CareerCardDisplay } from './career-card-fetcher/career-card-display'
import { careerCardQuery } from './career-card-fetcher/career-card-query'

export interface CareerCardFetcherProps {
  playerId: string
}

/** Thin fetcher: reads the career view off the profile bundle's shared cache
 * entry — the very same entry the hero and the Recent-matches card read — and
 * hands it to the display. No second request: the bundle already carries the
 * career block.
 *
 * It takes a player id and nothing else. Career is cross-league (ADR-0915), so
 * there is deliberately no league to thread through here. */
export function CareerCardFetcher({ playerId }: CareerCardFetcherProps) {
  const { data: career } = useSuspenseQuery(careerCardQuery(playerId))

  return <CareerCardDisplay career={career} />
}
