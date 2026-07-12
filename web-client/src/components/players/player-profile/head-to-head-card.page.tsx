import { ErrorBoundary } from 'react-error-boundary'

import {
  mockPlayerDetailEndpoint,
  type PlayerDetailResolver,
} from '@/mocks/endpoints/players/player-detail.endpoint'
import { server } from '@/mocks/server'
import { renderWithRoutes } from '@/test/router'
import { screen, type Container } from '@/test/utilities'

import { HeadToHeadCard, type HeadToHeadCardProps } from './head-to-head-card'
import {
  headToHeadCardDisplayPage,
  NEW_MATCH_ROUTE,
  PLAYER_PROFILE_ROUTE,
} from './head-to-head-card/head-to-head-card-fetcher/head-to-head-card-display.page'

const DEFAULT_PLAYER_ID = 'p-1'

const scoped = (container: Container) => ({
  /** `HeadToHeadCard`'s own `<Suspense>` fallback (the real
   * `HeadToHeadCardSkeleton`) while the bundle is pending. */
  queryLoading() {
    return container.queryByRole('status', { name: /loading head-to-head/i })
  },
  findLoading() {
    return container.findByRole('status', { name: /loading head-to-head/i })
  },
  /** The fallback rendered by the *ancestor* error boundary — the card owns
   * none. */
  queryError() {
    return container.queryByRole('alert')
  },
  ...headToHeadCardDisplayPage.within(container),
})

/**
 * Test page-object for the public `HeadToHeadCard` wrapper. It adds only a
 * `<Suspense>` (with its real skeleton) around the fetcher and deliberately has
 * no error boundary, so this renders it beneath the boundary the route supplies
 * in production. The router harness is here for the never-met CTA's `<Link>`.
 */
export const headToHeadCardPage = {
  mockEndpoint(resolver: PlayerDetailResolver) {
    mockPlayerDetailEndpoint(server, resolver)
  },

  render(overrides: Partial<HeadToHeadCardProps> = {}) {
    const props: HeadToHeadCardProps = {
      playerId: DEFAULT_PLAYER_ID,
      ...overrides,
    }

    renderWithRoutes(
      <ErrorBoundary
        fallbackRender={() => <div role="alert">Couldn’t load this player</div>}
      >
        <HeadToHeadCard {...props} />
      </ErrorBoundary>,
      // The never-met CTA, and — since chore 2b — every frequent-opponent name,
      // which is now a link to that opponent's profile.
      { linkTargets: [NEW_MATCH_ROUTE, PLAYER_PROFILE_ROUTE] },
    )
  },

  within(container: Container = screen) {
    return scoped(container)
  },

  ...scoped(screen),
}
