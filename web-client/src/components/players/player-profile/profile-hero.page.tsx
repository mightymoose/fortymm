import { ErrorBoundary } from 'react-error-boundary'

import {
  mockPlayerDetailEndpoint,
  type PlayerDetailResolver,
} from '@/mocks/endpoints/players/player-detail.endpoint'
import { server } from '@/mocks/server'
import { render, screen, type Container } from '@/test/utilities'

import { ProfileHero, type ProfileHeroProps } from './profile-hero'
import { profileHeroDisplayPage } from './profile-hero/profile-hero-fetcher/profile-hero-display.page'

const DEFAULT_PLAYER_ID = 'p-1'

const scoped = (container: Container) => ({
  /** `ProfileHero`'s own `<Suspense>` fallback (the real `ProfileHeroSkeleton`)
   * while the bundle is pending. */
  queryLoading() {
    return container.queryByRole('status', { name: /loading player/i })
  },
  /** The fallback rendered by the *ancestor* error boundary — the hero owns
   * none. */
  queryError() {
    return container.queryByRole('alert')
  },
  ...profileHeroDisplayPage.within(container),
})

/**
 * Test page-object for the public `ProfileHero` wrapper. It adds only a
 * `<Suspense>` (with its real skeleton) around the fetcher and deliberately has
 * no error boundary, so this renders it beneath the boundary the route supplies
 * in production.
 */
export const profileHeroPage = {
  mockEndpoint(resolver: PlayerDetailResolver) {
    mockPlayerDetailEndpoint(server, resolver)
  },

  render(overrides: Partial<ProfileHeroProps> = {}) {
    const props: ProfileHeroProps = {
      playerId: DEFAULT_PLAYER_ID,
      ...overrides,
    }

    render(
      <ErrorBoundary
        fallbackRender={() => <div role="alert">Couldn’t load this player</div>}
      >
        <ProfileHero {...props} />
      </ErrorBoundary>,
    )
  },

  within(container: Container = screen) {
    return scoped(container)
  },

  ...scoped(screen),
}
