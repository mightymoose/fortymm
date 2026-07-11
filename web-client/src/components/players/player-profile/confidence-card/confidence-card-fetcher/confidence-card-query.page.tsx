import { useQuery } from '@tanstack/react-query'

import {
  mockPlayerDetailEndpoint,
  type PlayerDetailResolver,
} from '@/mocks/endpoints/players/player-detail.endpoint'
import { server } from '@/mocks/server'
import { renderHook } from '@/test/utilities'

import { confidenceCardQuery } from './confidence-card-query'

const DEFAULT_PLAYER_ID = 'p-1'

/**
 * Test page-object for `confidenceCardQuery`. The query projects a
 * `ConfidenceView` off the profile bundle via `select` — the level's English
 * name, the rounded interval, the drawer's formatted RD and σ, and the `null`
 * that means "no card at all" — so those decisions are asserted here headlessly,
 * with no DOM.
 *
 * The *pronouns* are not here on purpose: who is looking changes the card's
 * voice, not its numbers, so that lives in the display.
 */
export const confidenceCardQueryPage = {
  mockEndpoint(resolver: PlayerDetailResolver) {
    mockPlayerDetailEndpoint(server, resolver)
  },

  /** Run the query under the shared retry-free client. `throwOnError` is off so a
   * failure lands on `result.current.error` rather than bubbling to a boundary.
   * `result.current.data` is the projected `ConfidenceView`, or `null`. */
  render(playerId: string = DEFAULT_PLAYER_ID) {
    return renderHook(() =>
      useQuery({ ...confidenceCardQuery(playerId), throwOnError: false }),
    )
  },
}
