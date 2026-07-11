import { Suspense } from 'react'
import { ErrorBoundary } from 'react-error-boundary'

import {
  mockPlayerDetailEndpoint,
  type PlayerDetailResolver,
} from '@/mocks/endpoints/players/player-detail.endpoint'
import { server } from '@/mocks/server'
import { render, screen, type Container } from '@/test/utilities'

import {
  RatingPanelFetcher,
  type RatingPanelFetcherProps,
} from './rating-panel-fetcher'
import { ratingPanelDisplayPage } from './rating-panel-fetcher/rating-panel-display.page'

const DEFAULT_PLAYER_ID = 'p-1'

const scoped = (container: Container) => ({
  /** The Suspense fallback shown while the profile bundle is pending. */
  queryLoading() {
    return container.queryByRole('status', { name: /loading rating/i })
  },
  /** The fallback rendered by the *ancestor* error boundary — the card owns
   * none, by design. */
  queryError() {
    return container.queryByRole('alert')
  },
  ...ratingPanelDisplayPage.within(container),
})

/**
 * Test page-object for `RatingPanelFetcher`. Mirrors the real `RatingPanel`
 * wrapper (a `<Suspense>`) plus the ancestor `ErrorBoundary` the route supplies,
 * and stubs the same `GET /v1/players/:playerId` bundle the query projects off.
 */
export const ratingPanelFetcherPage = {
  mockEndpoint(resolver: PlayerDetailResolver) {
    mockPlayerDetailEndpoint(server, resolver)
  },

  render(overrides: Partial<RatingPanelFetcherProps> = {}) {
    const props: RatingPanelFetcherProps = {
      playerId: DEFAULT_PLAYER_ID,
      ...overrides,
    }

    render(
      <ErrorBoundary
        fallbackRender={() => <div role="alert">Couldn’t load this player</div>}
      >
        <Suspense
          fallback={
            <div role="status" aria-label="Loading rating">
              Loading…
            </div>
          }
        >
          <RatingPanelFetcher {...props} />
        </Suspense>
      </ErrorBoundary>,
    )
  },

  within(container: Container = screen) {
    return scoped(container)
  },

  ...scoped(screen),
}
