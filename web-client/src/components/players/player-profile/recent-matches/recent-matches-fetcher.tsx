import { useSuspenseQuery } from '@tanstack/react-query'

import { RecentMatchesDisplay } from './recent-matches-fetcher/recent-matches-display'
import { recentMatchesQuery } from './recent-matches-fetcher/recent-matches-query'

export interface RecentMatchesFetcherProps {
  playerId: string
  /** The ladder this card's numbers are about (ADR-0915), from the profile's
   * `?league=`. `undefined` is the **default league** — the URL carries no param
   * for it. It is part of the bundle's query key, so every card on the page must
   * be handed the same one or the profile forks into two requests. */
  leagueId?: string
}

/** Thin fetcher: reads the six recent matches off the profile bundle's shared
 * cache entry — the very same entry the hero reads — and hands them to the
 * display. No second request: the bundle already carries them. */
export function RecentMatchesFetcher({ playerId, leagueId }: RecentMatchesFetcherProps) {
  const { data: recent } = useSuspenseQuery(recentMatchesQuery(playerId, leagueId))

  return <RecentMatchesDisplay recent={recent} />
}
