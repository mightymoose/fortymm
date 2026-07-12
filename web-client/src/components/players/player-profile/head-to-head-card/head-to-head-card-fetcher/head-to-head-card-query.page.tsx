import { useQuery } from '@tanstack/react-query'

import {
  mockPlayerDetailEndpoint,
  type PlayerDetailResolver,
} from '@/mocks/endpoints/players/player-detail.endpoint'
import { server } from '@/mocks/server'
import { renderHook } from '@/test/utilities'

import { headToHeadCardQuery } from './head-to-head-card-query'

const DEFAULT_PLAYER_ID = 'p-1'

/**
 * Test page-object for `headToHeadCardQuery`. The query projects a
 * `HeadToHeadView` off the profile bundle via `select` — whose side each record is
 * read from, the formatted counts and dates, the win-share each bar is drawn at,
 * and the `null` that means "this is your own profile" — so those decisions are
 * asserted here headlessly, with no DOM.
 */
export const headToHeadCardQueryPage = {
  mockEndpoint(resolver: PlayerDetailResolver) {
    mockPlayerDetailEndpoint(server, resolver)
  },

  /** Run the query under the shared retry-free client. `throwOnError` is off so a
   * failure lands on `result.current.error` rather than bubbling to a boundary.
   * `result.current.data` is the projected `HeadToHeadView`. */
  render(playerId: string = DEFAULT_PLAYER_ID) {
    return renderHook(() =>
      useQuery({ ...headToHeadCardQuery(playerId), throwOnError: false }),
    )
  },
}
