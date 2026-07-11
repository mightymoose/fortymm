import { HttpResponse } from 'msw'
import { ErrorBoundary } from 'react-error-boundary'

import {
  mockPlayerDetailEndpoint,
  type PlayerDetailResolver,
} from '@/mocks/endpoints/players/player-detail.endpoint'
import { mockSessionEndpoint } from '@/mocks/endpoints/session/session.endpoint'
import { server } from '@/mocks/server'
import { sessionResponse } from '@/test/factories'
import { render, screen, type Container } from '@/test/utilities'

import { ConfidenceCard, type ConfidenceCardProps } from './confidence-card'
import { confidenceCardDisplayPage } from './confidence-card/confidence-card-fetcher/confidence-card-display.page'

const DEFAULT_PLAYER_ID = 'p-1'

const scoped = (container: Container) => ({
  /** `ConfidenceCard`'s own `<Suspense>` fallback (the real
   * `ConfidenceCardSkeleton`) while the bundle is pending. */
  queryLoading() {
    return container.queryByRole('status', { name: /loading confidence/i })
  },
  findLoading() {
    return container.findByRole('status', { name: /loading confidence/i })
  },
  /** The fallback rendered by the *ancestor* error boundary — the card owns
   * none. */
  queryError() {
    return container.queryByRole('alert')
  },
  ...confidenceCardDisplayPage.within(container),
})

/**
 * Test page-object for the public `ConfidenceCard` wrapper. It adds only a
 * `<Suspense>` (with its real skeleton) around the fetcher and deliberately has
 * no error boundary, so this renders it beneath the boundary the route supplies
 * in production.
 */
export const confidenceCardPage = {
  mockEndpoint(resolver: PlayerDetailResolver) {
    mockPlayerDetailEndpoint(server, resolver)
  },

  /** Make the session's own user the player with `viewerId` — i.e. say who is
   * looking. Pass the profile's own id for the second-person copy. */
  signInAs(viewerId: string) {
    mockSessionEndpoint(server, () =>
      HttpResponse.json(sessionResponse({ user: { id: viewerId } })),
    )
  },

  render(overrides: Partial<ConfidenceCardProps> = {}) {
    const props: ConfidenceCardProps = {
      playerId: DEFAULT_PLAYER_ID,
      ...overrides,
    }

    render(
      <ErrorBoundary
        fallbackRender={() => <div role="alert">Couldn’t load this player</div>}
      >
        <ConfidenceCard {...props} />
      </ErrorBoundary>,
    )
  },

  within(container: Container = screen) {
    return scoped(container)
  },

  ...scoped(screen),
}
