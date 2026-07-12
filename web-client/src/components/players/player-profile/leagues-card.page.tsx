import { ErrorBoundary } from 'react-error-boundary'

import {
  mockPlayerDetailEndpoint,
  type PlayerDetailResolver,
} from '@/mocks/endpoints/players/player-detail.endpoint'
import { server } from '@/mocks/server'
import { renderWithRoutes } from '@/test/router'
import { screen, type Container } from '@/test/utilities'

import { LeaguesCard, type LeaguesCardProps } from './leagues-card'
import {
  leaguesCardDisplayPage,
  PROFILE_ROUTE,
} from './leagues-card/leagues-card-fetcher/leagues-card-display.page'

const DEFAULT_PLAYER_ID = 'p-1'

const scoped = (container: Container) => ({
  /** `LeaguesCard`'s own `<Suspense>` fallback (the real `LeaguesCardSkeleton`)
   * while the bundle is pending. */
  queryLoading() {
    return container.queryByRole('status', { name: /loading leagues/i })
  },
  findLoading() {
    return container.findByRole('status', { name: /loading leagues/i })
  },
  /** The fallback rendered by the *ancestor* error boundary — the card owns
   * none. */
  queryError() {
    return container.queryByRole('alert')
  },
  ...leaguesCardDisplayPage.within(container),
})

/**
 * Test page-object for the public `LeaguesCard` wrapper. It adds only a
 * `<Suspense>` (with its real skeleton) around the fetcher and deliberately has
 * no error boundary, so this renders it beneath the boundary the route supplies
 * in production — and under the router harness the rows' typed `<Link>`s need.
 */
export const leaguesCardPage = {
  mockEndpoint(resolver: PlayerDetailResolver) {
    mockPlayerDetailEndpoint(server, resolver)
  },

  render(overrides: Partial<LeaguesCardProps> = {}) {
    const props: LeaguesCardProps = {
      playerId: DEFAULT_PLAYER_ID,
      ...overrides,
    }

    renderWithRoutes(
      <ErrorBoundary
        fallbackRender={() => <div role="alert">Couldn’t load this player</div>}
      >
        <LeaguesCard {...props} />
      </ErrorBoundary>,
      { linkTargets: [PROFILE_ROUTE] },
    )
  },

  within(container: Container = screen) {
    return scoped(container)
  },

  ...scoped(screen),
}
