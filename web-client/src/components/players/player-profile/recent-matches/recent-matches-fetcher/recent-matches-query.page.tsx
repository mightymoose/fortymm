import { useQuery } from '@tanstack/react-query'

import {
  mockPlayerDetailEndpoint,
  type PlayerDetailResolver,
} from '@/mocks/endpoints/players/player-detail.endpoint'
import { server } from '@/mocks/server'
import { renderHook } from '@/test/utilities'

import { recentMatchesQuery } from './recent-matches-query'

const DEFAULT_PLAYER_ID = 'p-1'

/**
 * Test page-object for `recentMatchesQuery`. The query projects a
 * `RecentMatchesView` off the profile bundle via `select` — every label the card
 * renders ("Live", "Awaiting", the em dash, "View all 50 matches") is derived
 * there, so it is asserted here headlessly, with no DOM.
 */
export const recentMatchesQueryPage = {
  mockEndpoint(resolver: PlayerDetailResolver) {
    mockPlayerDetailEndpoint(server, resolver)
  },

  /** Run the query under the shared retry-free client. `throwOnError` is off so
   * a failure lands on `result.current.error` rather than bubbling to a
   * boundary. `result.current.data` is the projected `RecentMatchesView`. */
  render(playerId: string = DEFAULT_PLAYER_ID) {
    return renderHook(() =>
      useQuery({ ...recentMatchesQuery(playerId), throwOnError: false }),
    )
  },
}
