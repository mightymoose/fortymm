import { HttpResponse } from 'msw'
import { Suspense } from 'react'
import { ErrorBoundary } from 'react-error-boundary'

import {
  mockPlayerDetailEndpoint,
  type PlayerDetailResolver,
} from '@/mocks/endpoints/players/player-detail.endpoint'
import { mockSessionEndpoint } from '@/mocks/endpoints/session/session.endpoint'
import { server } from '@/mocks/server'
import { sessionResponse } from '@/test/factories'
import { render, screen, type Container } from '@/test/utilities'

import {
  ConfidenceCardFetcher,
  type ConfidenceCardFetcherProps,
} from './confidence-card-fetcher'
import { confidenceCardDisplayPage } from './confidence-card-fetcher/confidence-card-display.page'

const DEFAULT_PLAYER_ID = 'p-1'

const scoped = (container: Container) => ({
  /** The Suspense fallback while the profile bundle is pending. */
  queryLoading() {
    return container.queryByRole('status', { name: /loading confidence/i })
  },
  findLoading() {
    return container.findByRole('status', { name: /loading confidence/i })
  },
  /** The fallback rendered by the *ancestor* error boundary. The card owns no
   * boundary of its own — a failed bundle query belongs to the route. */
  queryError() {
    return container.queryByRole('alert')
  },
  findError() {
    return container.findByRole('alert')
  },
  ...confidenceCardDisplayPage.within(container),
})

/**
 * Test page-object for `ConfidenceCardFetcher`. The fetcher reads via
 * `useSuspenseQuery`, so this mirrors the real `ConfidenceCard` wrapper — a
 * `<Suspense>` plus the ancestor `ErrorBoundary` the route provides — and stubs
 * the profile bundle the card projects off.
 *
 * It also stubs **who is looking**: the card is the profile's first viewer-aware
 * surface, so `signInAs(playerId)` is how a test says "this is *your* profile"
 * and gets the second-person copy.
 */
export const confidenceCardFetcherPage = {
  mockEndpoint(resolver: PlayerDetailResolver) {
    mockPlayerDetailEndpoint(server, resolver)
  },

  /**
   * Make the session's own user the player with `viewerId`.
   *
   * `handlers.ts` has a global session handler, so leaving this out doesn't blow
   * up — it just leaves the viewer as somebody else, which is the third-person
   * case. Pass the *profile's* id to get the second-person one.
   */
  signInAs(viewerId: string) {
    mockSessionEndpoint(server, () =>
      HttpResponse.json(sessionResponse({ user: { id: viewerId } })),
    )
  },

  render(overrides: Partial<ConfidenceCardFetcherProps> = {}) {
    const props: ConfidenceCardFetcherProps = {
      playerId: DEFAULT_PLAYER_ID,
      ...overrides,
    }

    render(
      <ErrorBoundary
        fallbackRender={() => <div role="alert">Couldn’t load this player</div>}
      >
        <Suspense
          fallback={
            <div role="status" aria-label="Loading confidence">
              Loading…
            </div>
          }
        >
          <ConfidenceCardFetcher {...props} />
        </Suspense>
      </ErrorBoundary>,
    )
  },

  within(container: Container = screen) {
    return scoped(container)
  },

  ...scoped(screen),
}
