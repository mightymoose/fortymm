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
  RecentMatchesFetcher,
  type RecentMatchesFetcherProps,
} from './recent-matches-fetcher'
import {
  MATCH_HISTORY_ROUTE,
  recentMatchesDisplayPage,
} from './recent-matches-fetcher/recent-matches-display.page'

const DEFAULT_PLAYER_ID = 'p-1'

const scoped = (container: Container) => ({
  /** The Suspense fallback shown while the profile bundle is pending. The router
   * paints asynchronously, so a test must `await findLoading()` before it can
   * assert on the pending state. */
  queryLoading() {
    return container.queryByRole('status', { name: /loading matches/i })
  },
  findLoading() {
    return container.findByRole('status', { name: /loading matches/i })
  },
  /** The fallback rendered by the *ancestor* error boundary. The card owns no
   * boundary of its own — a failed bundle query belongs to the route. */
  queryError() {
    return container.queryByRole('alert')
  },
  findError() {
    return container.findByRole('alert')
  },
  ...recentMatchesDisplayPage.within(container),
})

/**
 * Test page-object for `RecentMatchesFetcher`. The fetcher reads via
 * `useSuspenseQuery`, so this mirrors the real `RecentMatches` wrapper — a
 * `<Suspense>` plus the ancestor `ErrorBoundary` the route provides — stubs the
 * same `GET /v1/players/:playerId` bundle the card projects off, and supplies
 * the router the footer link needs.
 *
 * Note what it does **not** stub: `/v1/players/:id/matches`. The card must not
 * fetch it — MSW's `onUnhandledRequest: 'error'` fails the test if it does.
 */
export const recentMatchesFetcherPage = {
  mockEndpoint(resolver: PlayerDetailResolver) {
    mockPlayerDetailEndpoint(server, resolver)
  },

  render(overrides: Partial<RecentMatchesFetcherProps> = {}) {
    const props: RecentMatchesFetcherProps = {
      playerId: DEFAULT_PLAYER_ID,
      ...overrides,
    }

    renderWithRoutes(
      <ErrorBoundary
        fallbackRender={() => <div role="alert">Couldn’t load this player</div>}
      >
        <Suspense
          fallback={
            <div role="status" aria-label="Loading matches">
              Loading…
            </div>
          }
        >
          <RecentMatchesFetcher {...props} />
        </Suspense>
      </ErrorBoundary>,
      { linkTargets: [MATCH_HISTORY_ROUTE] },
    )
  },

  within(container: Container = screen) {
    return scoped(container)
  },

  ...scoped(screen),
}
