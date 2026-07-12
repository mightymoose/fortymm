import { Suspense } from 'react'
import { ErrorBoundary } from 'react-error-boundary'

import {
  mockPlayerDetailEndpoint,
  type PlayerDetailResolver,
} from '@/mocks/endpoints/players/player-detail.endpoint'
import { server } from '@/mocks/server'
import { render, screen, type Container } from '@/test/utilities'

import {
  ProfileHeroFetcher,
  type ProfileHeroFetcherProps,
} from './profile-hero-fetcher'
import { profileHeroDisplayPage } from './profile-hero-fetcher/profile-hero-display.page'

const DEFAULT_PLAYER_ID = 'p-1'

const scoped = (container: Container) => ({
  /** The Suspense fallback shown while the profile bundle is pending. */
  queryLoading() {
    return container.queryByRole('status', { name: /loading player/i })
  },
  /** The fallback rendered by the *ancestor* error boundary. The hero owns no
   * boundary of its own — a failed bundle query is meant to propagate up to the
   * route — so this models the boundary the profile route supplies. */
  queryError() {
    return container.queryByRole('alert')
  },
  ...profileHeroDisplayPage.within(container),
})

/**
 * Test page-object for `ProfileHeroFetcher`. The fetcher reads via
 * `useSuspenseQuery`, so this mirrors the real `ProfileHero` wrapper — a
 * `<Suspense>` plus the ancestor `ErrorBoundary` the route provides — and stubs
 * the same `GET /v1/players/:playerId` bundle the query projects off.
 */
export const profileHeroFetcherPage = {
  mockEndpoint(resolver: PlayerDetailResolver) {
    mockPlayerDetailEndpoint(server, resolver)
  },

  render(overrides: Partial<ProfileHeroFetcherProps> = {}) {
    const props: ProfileHeroFetcherProps = {
      playerId: DEFAULT_PLAYER_ID,
      ...overrides,
    }

    render(
      <ErrorBoundary
        fallbackRender={() => <div role="alert">Couldn’t load this player</div>}
      >
        <Suspense
          fallback={
            <div role="status" aria-label="Loading player">
              Loading…
            </div>
          }
        >
          <ProfileHeroFetcher {...props} />
        </Suspense>
      </ErrorBoundary>,
    )
  },

  within(container: Container = screen) {
    return scoped(container)
  },

  ...scoped(screen),
}
