import { ErrorBoundary } from 'react-error-boundary'

import {
  mockPlayerDetailEndpoint,
  type PlayerDetailResolver,
} from '@/mocks/endpoints/players/player-detail.endpoint'
import { server } from '@/mocks/server'
import { renderWithRoutes } from '@/test/router'
import { screen, type Container } from '@/test/utilities'

import { RecentMatches, type RecentMatchesProps } from './recent-matches'
import {
  MATCH_HISTORY_ROUTE,
  recentMatchesDisplayPage,
} from './recent-matches/recent-matches-fetcher/recent-matches-display.page'

const DEFAULT_PLAYER_ID = 'p-1'

const scoped = (container: Container) => ({
  /** `RecentMatches`' own `<Suspense>` fallback (the real
   * `RecentMatchesSkeleton`) while the bundle is pending. The router paints
   * asynchronously, so `await findLoading()` before asserting on it. */
  queryLoading() {
    return container.queryByRole('status', { name: /loading matches/i })
  },
  findLoading() {
    return container.findByRole('status', { name: /loading matches/i })
  },
  /** The fallback rendered by the *ancestor* error boundary — the card owns
   * none. */
  queryError() {
    return container.queryByRole('alert')
  },
  ...recentMatchesDisplayPage.within(container),
})

/**
 * Test page-object for the public `RecentMatches` wrapper. It adds only a
 * `<Suspense>` (with its real skeleton) around the fetcher and deliberately has
 * no error boundary, so this renders it beneath the boundary the route supplies
 * in production — and under the router its footer link needs.
 */
export const recentMatchesPage = {
  mockEndpoint(resolver: PlayerDetailResolver) {
    mockPlayerDetailEndpoint(server, resolver)
  },

  render(overrides: Partial<RecentMatchesProps> = {}) {
    const props: RecentMatchesProps = {
      playerId: DEFAULT_PLAYER_ID,
      ...overrides,
    }

    renderWithRoutes(
      <ErrorBoundary
        fallbackRender={() => <div role="alert">Couldn’t load this player</div>}
      >
        <RecentMatches {...props} />
      </ErrorBoundary>,
      { linkTargets: [MATCH_HISTORY_ROUTE] },
    )
  },

  within(container: Container = screen) {
    return scoped(container)
  },

  ...scoped(screen),
}
