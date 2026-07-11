import { useSuspenseQuery } from '@tanstack/react-query'

import { CareerCardDisplay } from './career-card-fetcher/career-card-display'
import { careerCardQuery } from './career-card-fetcher/career-card-query'

export interface CareerCardFetcherProps {
  playerId: string
  /** The ladder this card's numbers are about (ADR-0915), from the profile's
   * `?league=`. `undefined` is the **default league** — the URL carries no param
   * for it. It is part of the bundle's query key, so every card on the page must
   * be handed the same one or the profile forks into two requests. */
  leagueId?: string
}

/** Thin fetcher: reads the career view off the profile bundle's shared cache
 * entry — the very same entry the hero and the Recent-matches card read — and
 * hands it to the display. No second request: the bundle already carries the
 * career block.
 *
 * It takes a player id and nothing else. Career is cross-league (ADR-0915), so
 * there is deliberately no league to thread through here. */
export function CareerCardFetcher({ playerId, leagueId }: CareerCardFetcherProps) {
  const { data: career } = useSuspenseQuery(careerCardQuery(playerId, leagueId))

  return <CareerCardDisplay career={career} />
}
