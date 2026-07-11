import { useSuspenseQuery } from '@tanstack/react-query'

import { RecentMatchesDisplay } from './recent-matches-fetcher/recent-matches-display'
import { recentMatchesQuery } from './recent-matches-fetcher/recent-matches-query'

export interface RecentMatchesFetcherProps {
  playerId: string
}

/** Thin fetcher: reads the six recent matches off the profile bundle's shared
 * cache entry — the very same entry the hero reads — and hands them to the
 * display. No second request: the bundle already carries them. */
export function RecentMatchesFetcher({ playerId }: RecentMatchesFetcherProps) {
  const { data: recent } = useSuspenseQuery(recentMatchesQuery(playerId))

  return <RecentMatchesDisplay recent={recent} />
}
