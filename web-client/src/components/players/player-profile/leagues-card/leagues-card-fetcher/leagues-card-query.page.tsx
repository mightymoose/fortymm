import { useQuery } from '@tanstack/react-query'

import {
  mockPlayerDetailEndpoint,
  type PlayerDetailResolver,
} from '@/mocks/endpoints/players/player-detail.endpoint'
import { server } from '@/mocks/server'
import { renderHook } from '@/test/utilities'

import { leaguesCardQuery } from './leagues-card-query'

const DEFAULT_PLAYER_ID = 'p-1'

/**
 * Test page-object for `leaguesCardQuery`. The query projects a `LeaguesView` off
 * the profile bundle via `select`: the rating formatting (an em dash for a ladder
 * the player holds no rating on) and — the load-bearing one — *which row is
 * selected*, which is derived from the league the URL named rather than read off
 * the response. Asserted here headlessly, with no DOM.
 */
export const leaguesCardQueryPage = {
  mockEndpoint(resolver: PlayerDetailResolver) {
    mockPlayerDetailEndpoint(server, resolver)
  },

  /** Run the query under the shared retry-free client. `throwOnError` is off so a
   * failure lands on `result.current.error` rather than bubbling to a boundary.
   * `result.current.data` is the projected `LeaguesView`.
   *
   * `leagueId` is the league the URL asked for — `undefined` meaning the default
   * league, i.e. a URL with no `?league=` at all. */
  render(leagueId?: string, playerId: string = DEFAULT_PLAYER_ID) {
    return renderHook(() =>
      useQuery({
        ...leaguesCardQuery(playerId, leagueId),
        throwOnError: false,
      }),
    )
  },
}
