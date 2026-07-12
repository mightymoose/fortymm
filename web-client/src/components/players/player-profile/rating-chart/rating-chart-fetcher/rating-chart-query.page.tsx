import { useQuery } from '@tanstack/react-query'

import { ratingHistoryQueryOptions, type RatingRange } from '@/api/players'
import {
  mockRatingHistoryEndpoint,
  type RatingHistoryResolver,
} from '@/mocks/endpoints/players/rating-history.endpoint'
import { server } from '@/mocks/server'
import { renderHook } from '@/test/utilities'

const DEFAULT_PLAYER_ID = 'p-1'

/**
 * Test page-object for the chart's **own** query.
 *
 * The projection (`selectRatingChart`) is a pure function and is tested as one —
 * no hook, no DOM. What needs a harness is the *query*: that it is keyed on the
 * range, that it fetches the range it was asked for, and that a failure lands on
 * `result.current.error` rather than being thrown at a boundary (the chart is the
 * one card that must fail in place).
 */
export const ratingChartQueryPage = {
  mockEndpoint(resolver: RatingHistoryResolver) {
    mockRatingHistoryEndpoint(server, resolver)
  },

  /** Run the query under the shared retry-free client. Nothing overrides
   * `throwOnError` here — the options must not be throwing on their own. */
  render(
    options: { playerId?: string; leagueId?: string; range?: RatingRange } = {},
  ) {
    const { playerId = DEFAULT_PLAYER_ID, ...rest } = options
    return renderHook(() => useQuery(ratingHistoryQueryOptions(playerId, rest)))
  },
}
