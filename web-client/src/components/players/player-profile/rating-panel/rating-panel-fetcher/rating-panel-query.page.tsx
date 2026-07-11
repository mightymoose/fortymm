import { useQuery } from '@tanstack/react-query'

import {
  mockPlayerDetailEndpoint,
  type PlayerDetailResolver,
} from '@/mocks/endpoints/players/player-detail.endpoint'
import { server } from '@/mocks/server'
import { renderHook } from '@/test/utilities'

import { ratingPanelQuery } from './rating-panel-query'

const DEFAULT_PLAYER_ID = 'p-1'

/**
 * Test page-object for `ratingPanelQuery`. The query projects a
 * `RatingPanelView` off the profile bundle via `select` — all the label and
 * format logic ("#3 of 42", "+12", "Last 10: …") lives there, so it is asserted
 * here headlessly, with no DOM.
 */
export const ratingPanelQueryPage = {
  mockEndpoint(resolver: PlayerDetailResolver) {
    mockPlayerDetailEndpoint(server, resolver)
  },

  /** Run the query under the shared retry-free client. `throwOnError` is off so
   * a failure lands on `result.current.error` rather than bubbling to a
   * boundary. `result.current.data` is the projected `RatingPanelView`. */
  render(playerId: string = DEFAULT_PLAYER_ID) {
    return renderHook(() =>
      useQuery({ ...ratingPanelQuery(playerId), throwOnError: false }),
    )
  },
}
