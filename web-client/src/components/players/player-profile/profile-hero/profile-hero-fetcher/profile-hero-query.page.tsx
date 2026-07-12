import { useQuery } from '@tanstack/react-query'

import {
  mockPlayerDetailEndpoint,
  type PlayerDetailResolver,
} from '@/mocks/endpoints/players/player-detail.endpoint'
import { server } from '@/mocks/server'
import { renderHook } from '@/test/utilities'

import { profileHeroQuery } from './profile-hero-query'

const DEFAULT_PLAYER_ID = 'p-1'

/**
 * Test page-object for `profileHeroQuery`. The query projects a
 * `ProfileHeroView` off the profile bundle via `select`, so the test stubs the
 * same `GET /v1/players/:playerId` endpoint the bundle reads and asserts on the
 * projected view — no DOM involved.
 */
export const profileHeroQueryPage = {
  /** Stub `GET /v1/players/:playerId` — `HttpResponse.json(buildPlayerDetail())`
   * for the happy path, a non-2xx for the error branch. */
  mockEndpoint(resolver: PlayerDetailResolver) {
    mockPlayerDetailEndpoint(server, resolver)
  },

  /** Run the query under the shared retry-free client. `throwOnError` is
   * disabled here so a failure lands on `result.current.error` instead of
   * bubbling to a boundary — boundary behavior is covered at the wrapper and
   * route level. `result.current.data` is the projected `ProfileHeroView`. */
  render(playerId: string = DEFAULT_PLAYER_ID) {
    return renderHook(() =>
      useQuery({ ...profileHeroQuery(playerId), throwOnError: false }),
    )
  },
}
