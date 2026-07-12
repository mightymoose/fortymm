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
import { renderWithRoutes } from '@/test/router'
import { screen, type Container } from '@/test/utilities'

import {
  HeadToHeadCardFetcher,
  type HeadToHeadCardFetcherProps,
} from './head-to-head-card-fetcher'
import {
  headToHeadCardDisplayPage,
  NEW_MATCH_ROUTE,
  PLAYER_PROFILE_ROUTE,
} from './head-to-head-card-fetcher/head-to-head-card-display.page'

const DEFAULT_PLAYER_ID = 'p-1'

const scoped = (container: Container) => ({
  /** The Suspense fallback while the profile bundle is pending. */
  queryLoading() {
    return container.queryByRole('status', { name: /loading head-to-head/i })
  },
  findLoading() {
    return container.findByRole('status', { name: /loading head-to-head/i })
  },
  /** The fallback rendered by the *ancestor* error boundary. The card owns no
   * boundary of its own — a failed bundle query belongs to the route. */
  queryError() {
    return container.queryByRole('alert')
  },
  findError() {
    return container.findByRole('alert')
  },
  ...headToHeadCardDisplayPage.within(container),
})

/**
 * Test page-object for `HeadToHeadCardFetcher`. The fetcher reads via
 * `useSuspenseQuery`, so this mirrors the real `HeadToHeadCard` wrapper — a
 * `<Suspense>` plus the ancestor `ErrorBoundary` the route provides — and stubs
 * the profile bundle the card projects off. The router harness is here for the
 * never-met state's Start-a-match `<Link>`.
 *
 * **`signInAs` is deliberately available but load-bearing in the negative.** This
 * card reads who is looking off the *payload* (the API omits `versus_viewer`
 * exactly when the caller is the player), not off the session — so a test can
 * withhold or break the session entirely and the card must still render the right
 * one of its two shapes. That is what `signInAs` is for here: proving the card
 * does **not** depend on it.
 */
export const headToHeadCardFetcherPage = {
  mockEndpoint(resolver: PlayerDetailResolver) {
    mockPlayerDetailEndpoint(server, resolver)
  },

  /** Make the session's own user the player with `viewerId` — i.e. say who is
   * looking. The card must not need this; see the class docstring. */
  signInAs(viewerId: string) {
    mockSessionEndpoint(server, () =>
      HttpResponse.json(sessionResponse({ user: { id: viewerId } })),
    )
  },

  /** A session that never arrives — so a card reading "is this me?" off the session
   * would be stuck on "not the viewer" forever. One that branched its *structure*
   * on that would render the wrong shape here; one that reads the payload, as every
   * card on this page does, cannot tell the difference. */
  withFailingSession() {
    mockSessionEndpoint(server, () => new HttpResponse(null, { status: 500 }))
  },

  render(overrides: Partial<HeadToHeadCardFetcherProps> = {}) {
    const props: HeadToHeadCardFetcherProps = {
      playerId: DEFAULT_PLAYER_ID,
      ...overrides,
    }

    renderWithRoutes(
      <ErrorBoundary
        fallbackRender={() => <div role="alert">Couldn’t load this player</div>}
      >
        <Suspense
          fallback={
            <div role="status" aria-label="Loading head-to-head">
              Loading…
            </div>
          }
        >
          <HeadToHeadCardFetcher {...props} />
        </Suspense>
      </ErrorBoundary>,
      // The Start-a-match CTA, and — since chore 2b — every frequent-opponent
      // name, which is now a link to that opponent's profile.
      { linkTargets: [NEW_MATCH_ROUTE, PLAYER_PROFILE_ROUTE] },
    )
  },

  within(container: Container = screen) {
    return scoped(container)
  },

  ...scoped(screen),
}
