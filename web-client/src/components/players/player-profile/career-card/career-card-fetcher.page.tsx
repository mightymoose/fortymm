import { Suspense } from 'react'
import { ErrorBoundary } from 'react-error-boundary'

import {
  mockPlayerDetailEndpoint,
  type PlayerDetailResolver,
} from '@/mocks/endpoints/players/player-detail.endpoint'
import { server } from '@/mocks/server'
import { render, screen, type Container } from '@/test/utilities'

import {
  CareerCardFetcher,
  type CareerCardFetcherProps,
} from './career-card-fetcher'
import { careerCardDisplayPage } from './career-card-fetcher/career-card-display.page'

const DEFAULT_PLAYER_ID = 'p-1'

const scoped = (container: Container) => ({
  /** The Suspense fallback while the profile bundle is pending. */
  queryLoading() {
    return container.queryByRole('status', { name: /loading career/i })
  },
  findLoading() {
    return container.findByRole('status', { name: /loading career/i })
  },
  /** The fallback rendered by the *ancestor* error boundary. The card owns no
   * boundary of its own — a failed bundle query belongs to the route. */
  queryError() {
    return container.queryByRole('alert')
  },
  findError() {
    return container.findByRole('alert')
  },
  ...careerCardDisplayPage.within(container),
})

/**
 * Test page-object for `CareerCardFetcher`. The fetcher reads via
 * `useSuspenseQuery`, so this mirrors the real `CareerCard` wrapper — a
 * `<Suspense>` plus the ancestor `ErrorBoundary` the route provides — and stubs
 * the same `GET /v1/players/:playerId` bundle the card projects off.
 *
 * That is the *only* endpoint stubbed: the career block rides on the bundle, so
 * any other request the card made would be unhandled and MSW
 * (`onUnhandledRequest: 'error'`) would fail the test.
 */
export const careerCardFetcherPage = {
  mockEndpoint(resolver: PlayerDetailResolver) {
    mockPlayerDetailEndpoint(server, resolver)
  },

  render(overrides: Partial<CareerCardFetcherProps> = {}) {
    const props: CareerCardFetcherProps = {
      playerId: DEFAULT_PLAYER_ID,
      ...overrides,
    }

    render(
      <ErrorBoundary
        fallbackRender={() => <div role="alert">Couldn’t load this player</div>}
      >
        <Suspense
          fallback={
            <div role="status" aria-label="Loading career">
              Loading…
            </div>
          }
        >
          <CareerCardFetcher {...props} />
        </Suspense>
      </ErrorBoundary>,
    )
  },

  within(container: Container = screen) {
    return scoped(container)
  },

  ...scoped(screen),
}
