import { useQuery } from '@tanstack/react-query'

import {
  mockPlayerDetailEndpoint,
  type PlayerDetailResolver,
} from '@/mocks/endpoints/players/player-detail.endpoint'
import { server } from '@/mocks/server'
import { renderHook } from '@/test/utilities'

import { careerCardQuery } from './career-card-query'

const DEFAULT_PLAYER_ID = 'p-1'

/**
 * Test page-object for `careerCardQuery`. The query projects a `CareerView` off
 * the profile bundle via `select` — every label and every format decision
 * ("68.6%", "On a 2-win streak", "35 decided · 2 leagues", the em dashes) lives
 * there, so they are asserted here headlessly, with no DOM.
 */
export const careerCardQueryPage = {
  mockEndpoint(resolver: PlayerDetailResolver) {
    mockPlayerDetailEndpoint(server, resolver)
  },

  /** Run the query under the shared retry-free client. `throwOnError` is off so
   * a failure lands on `result.current.error` rather than bubbling to a
   * boundary. `result.current.data` is the projected `CareerView`. */
  render(playerId: string = DEFAULT_PLAYER_ID) {
    return renderHook(() =>
      useQuery({ ...careerCardQuery(playerId), throwOnError: false }),
    )
  },
}
