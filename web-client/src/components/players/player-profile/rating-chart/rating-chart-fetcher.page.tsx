import { HttpResponse } from 'msw'
import { Suspense } from 'react'
import { ErrorBoundary } from 'react-error-boundary'

import {
  mockPlayerDetailEndpoint,
  type PlayerDetailResolver,
} from '@/mocks/endpoints/players/player-detail.endpoint'
import {
  mockRatingHistoryEndpoint,
  type RatingHistoryResolver,
} from '@/mocks/endpoints/players/rating-history.endpoint'
import { buildRatingHistoryWindow } from '@/mocks/factories/players/rating-history.factory'
import { server } from '@/mocks/server'
import { renderWithRoutes } from '@/test/router'
import { screen, type Container } from '@/test/utilities'

import {
  RatingChartFetcher,
  type RatingChartFetcherProps,
} from './rating-chart-fetcher'
import {
  PROFILE_ROUTE,
  ratingChartDisplayPage,
} from './rating-chart-fetcher/rating-chart-display.page'
import { unratedPanelPage } from './rating-chart-fetcher/unrated-panel.page'

const DEFAULT_PLAYER_ID = 'p-1'

/** The route-level boundary's copy — what the page shows when the *bundle* fails.
 * A failed **range** must never produce this. */
export const ROUTE_ERROR = 'Couldn’t load this player'

const scoped = (container: Container) => ({
  /** The `<Suspense>` fallback while the profile bundle is pending — the chart
   * card's real skeleton. Named "Loading chart", never "Loading rating chart":
   * the rating panel's skeleton is already "Loading rating" and the profile's page
   * object finds it by `/loading rating/i`. */
  queryChartSkeleton() {
    return container.queryByRole('status', { name: 'Loading chart' })
  },
  findChartSkeleton() {
    return container.findByRole('status', { name: 'Loading chart' })
  },
  /** The *route's* error fallback. The chart must not reach it: a failed range
   * belongs inside the card (`queryChartError`). */
  queryRouteError() {
    return container.queryByText(ROUTE_ERROR)
  },
  findRouteError() {
    return container.findByText(ROUTE_ERROR)
  },
  ...ratingChartDisplayPage.within(container),
  ...unratedPanelPage.within(container),
})

/**
 * Test page-object for `RatingChartFetcher` — the card's data layer, and the one
 * place on the profile where the data flow is not "project off the bundle".
 *
 * It mirrors the real wrapper (a `<Suspense>` with the chart's skeleton) and the
 * route (an error boundary), and stubs **both** endpoints the card can touch:
 *
 * - the **profile bundle**, which the card projects its rated/unrated gate off,
 *   and whose embedded `rating_history` block seeds the chart's cache;
 * - the **rating-history endpoint**, which the card must NOT call on first paint
 *   and must call exactly once per range flip. Both claims are about *requests*,
 *   so both resolvers count them.
 *
 * The range tabs are typed `<Link>`s, so this mounts under the router harness —
 * every test starts with an `await find…()`.
 */
export const ratingChartFetcherPage = {
  /** Stub `GET /v1/players/:id` — the bundle. Count its calls, and read the
   * `?range=` it carried: the window it embeds is the one the chart seeds from,
   * so "the bundle was asked for the range in the URL" is a real claim. */
  mockBundle(resolver: PlayerDetailResolver) {
    mockPlayerDetailEndpoint(server, resolver)
  },

  /**
   * Stub `GET /v1/players/:id/rating-history` — the chart's own endpoint.
   *
   * Leaving it unstubbed proves nothing: `handlers.ts` registers a global handler
   * that `resetHandlers()` restores between tests, so MSW would happily answer a
   * request the chart should never have made. Stub it with a counter instead, and
   * assert the count.
   */
  mockRatingHistory(resolver: RatingHistoryResolver) {
    mockRatingHistoryEndpoint(server, resolver)
  },

  /** A rating-history endpoint that records every range it is asked for. Returns
   * the ranges array — assert on it. */
  spyOnRatingHistory(): string[] {
    const asked: string[] = []
    mockRatingHistoryEndpoint(server, ({ request }) => {
      asked.push(new URL(request.url).searchParams.get('range') ?? 'none')
      return HttpResponse.json(buildRatingHistoryWindow())
    })
    return asked
  },

  render(overrides: Partial<RatingChartFetcherProps> = {}) {
    const props: RatingChartFetcherProps = {
      playerId: DEFAULT_PLAYER_ID,
      ...overrides,
    }

    renderWithRoutes(
      <ErrorBoundary fallbackRender={() => <div role="alert">{ROUTE_ERROR}</div>}>
        <Suspense
          fallback={
            <div role="status" aria-label="Loading chart">
              Loading…
            </div>
          }
        >
          <RatingChartFetcher {...props} />
        </Suspense>
      </ErrorBoundary>,
      { linkTargets: [PROFILE_ROUTE] },
    )
  },

  within(container: Container = screen) {
    return scoped(container)
  },

  ...scoped(screen),
}
