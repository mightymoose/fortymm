import { Suspense } from 'react'
import { ErrorBoundary } from 'react-error-boundary'

import {
  mockPlayerDetailEndpoint,
  type PlayerDetailResolver,
} from '@/mocks/endpoints/players/player-detail.endpoint'
import { server } from '@/mocks/server'
import { renderWithRoutes } from '@/test/router'
import { screen, type Container } from '@/test/utilities'

import {
  LeaguesCardFetcher,
  type LeaguesCardFetcherProps,
} from './leagues-card-fetcher'
import {
  leaguesCardDisplayPage,
  PROFILE_ROUTE,
} from './leagues-card-fetcher/leagues-card-display.page'

const DEFAULT_PLAYER_ID = 'p-1'

const scoped = (container: Container) => ({
  /** The Suspense fallback while the profile bundle is pending. */
  queryLoading() {
    return container.queryByRole('status', { name: /loading leagues/i })
  },
  findLoading() {
    return container.findByRole('status', { name: /loading leagues/i })
  },
  /** The fallback rendered by the *ancestor* error boundary. The card owns no
   * boundary of its own — a failed bundle query belongs to the route. */
  queryError() {
    return container.queryByRole('alert')
  },
  findError() {
    return container.findByRole('alert')
  },
  ...leaguesCardDisplayPage.within(container),
})

/**
 * Test page-object for `LeaguesCardFetcher`. The fetcher reads via
 * `useSuspenseQuery`, so this mirrors the real `LeaguesCard` wrapper — a
 * `<Suspense>` plus the ancestor `ErrorBoundary` the route provides — and stubs
 * the same `GET /v1/players/:playerId` bundle the card projects off.
 *
 * That is the *only* endpoint stubbed: `leagues` rides on the bundle, so any
 * other request the card made would be unhandled and MSW
 * (`onUnhandledRequest: 'error'`) would fail the test.
 *
 * Mounted under the router harness, because the rows are typed `<Link>`s back to
 * the profile — the league selection *is* the URL (ADR-0915).
 */
export const leaguesCardFetcherPage = {
  mockEndpoint(resolver: PlayerDetailResolver) {
    mockPlayerDetailEndpoint(server, resolver)
  },

  render(overrides: Partial<LeaguesCardFetcherProps> = {}) {
    const props: LeaguesCardFetcherProps = {
      playerId: DEFAULT_PLAYER_ID,
      ...overrides,
    }

    renderWithRoutes(
      <ErrorBoundary
        fallbackRender={() => <div role="alert">Couldn’t load this player</div>}
      >
        <Suspense
          fallback={
            <div role="status" aria-label="Loading leagues">
              Loading…
            </div>
          }
        >
          <LeaguesCardFetcher {...props} />
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
