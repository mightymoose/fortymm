import { type HttpResponseResolver, http } from 'msw'
import type { components } from '@/api/schema'
import type { server } from '../../server'
import type { worker } from '../../browser'

type Backend = typeof server | typeof worker
type RatingHistoryWindow = components['schemas']['RatingHistoryWindow']

export type RatingHistoryResolver = HttpResponseResolver<
  { playerId: string },
  never,
  RatingHistoryWindow
>

/**
 * Stub `GET /v1/players/:playerId/rating-history` — the chart's **own** endpoint,
 * and the one narrow request a range flip makes (ADR-0915).
 *
 * The chart does *not* call it on first paint: its cache is seeded from the
 * `rating_history` block the profile bundle already carries, for the range the
 * page loaded with. A test that wants to prove that cannot simply leave this
 * unstubbed — `handlers.ts` registers a global handler, restored by
 * `resetHandlers()` between tests, so MSW would answer the request rather than
 * fail on it. Override it with a *counting* resolver and assert it was never
 * called.
 *
 * The resolver receives the request, so a test can also read the `range` and
 * `league_id` a flip asked for — "it fetched exactly the range you clicked" is a
 * claim about the URL, not just about the call count.
 */
export const mockRatingHistoryEndpoint = (
  backend: Backend,
  resolver: RatingHistoryResolver,
) => backend.use(http.get('*/v1/players/:playerId/rating-history', resolver))
