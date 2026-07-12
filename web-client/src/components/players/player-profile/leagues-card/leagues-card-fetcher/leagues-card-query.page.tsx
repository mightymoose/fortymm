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
 * the profile bundle via `select` — the rows and their rating formatting (an em
 * dash for a ladder the player holds no rating on). Asserted here headlessly, with
 * no DOM.
 *
 * *Which row is selected* is deliberately **not** part of that view: it follows
 * from the league the URL named, not from the response, so it is derived in
 * `LeaguesCardDisplay` and asserted there. `leagueId` still matters here — it is
 * part of the bundle's **key** and rides on the request.
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
