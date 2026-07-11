import { HttpResponse } from 'msw'
import { ErrorBoundary } from 'react-error-boundary'

import {
  mockPlayerDetailEndpoint,
  type PlayerDetailResolver,
} from '@/mocks/endpoints/players/player-detail.endpoint'
import { mockPlayerMatchesEndpoint } from '@/mocks/endpoints/players/player-matches.endpoint'
import { server } from '@/mocks/server'
import { renderWithRoutes } from '@/test/router'
import { screen, type Container } from '@/test/utilities'

import { PlayerProfile, type PlayerProfileProps } from './player-profile'
import { careerCardDisplayPage } from './player-profile/career-card/career-card-fetcher/career-card-display.page'
import { profileHeroDisplayPage } from './player-profile/profile-hero/profile-hero-fetcher/profile-hero-display.page'
import { ratingPanelDisplayPage } from './player-profile/rating-panel/rating-panel-fetcher/rating-panel-display.page'
import {
  MATCH_HISTORY_ROUTE,
  recentMatchesDisplayPage,
} from './player-profile/recent-matches/recent-matches-fetcher/recent-matches-display.page'

const DEFAULT_PLAYER_ID = 'p-1'

const scoped = (container: Container) => ({
  /** The identity card's skeleton, while the bundle is pending. The router
   * paints asynchronously, so reach for `findHeroLoading()` first. */
  queryHeroLoading() {
    return container.queryByRole('status', { name: /loading player/i })
  },
  findHeroLoading() {
    return container.findByRole('status', { name: /loading player/i })
  },
  /** The standing card's skeleton, while the bundle is pending. */
  queryStandingLoading() {
    return container.queryByRole('status', { name: /loading rating/i })
  },
  /** The Recent matches card's skeleton, while the bundle is pending. */
  queryMatchesLoading() {
    return container.queryByRole('status', { name: /loading matches/i })
  },
  /** The Career card's skeleton, while the bundle is pending. */
  queryCareerLoading() {
    return container.queryByRole('status', { name: /loading career/i })
  },
  /** The route-level error boundary's fallback. No card owns a boundary. */
  queryError() {
    return container.queryByRole('alert')
  },
  findError() {
    return container.findByRole('alert')
  },
  ...profileHeroDisplayPage.within(container),
  ...ratingPanelDisplayPage.within(container),
  ...recentMatchesDisplayPage.within(container),
  // Career's accessors are all career-prefixed (`getCareerTotal`,
  // `getCareerRecord`, `getRingFigure`, `queryCareerTile`), so they compose with
  // the three above rather than shadowing them.
  ...careerCardDisplayPage.within(container),
})

/**
 * Test page-object for the `PlayerProfile` composition root. It renders the
 * self-fetching cards, so this stubs the profile bundle they all project off —
 * and **only** that bundle. The Recent matches card reads the six matches the
 * bundle already carries, so a call to `/v1/players/:id/matches` from this page
 * would be a regression — watch for it with `spyOnMatchHistoryEndpoint`.
 *
 * The card's "View all" footer is a typed `<Link>`, so the profile mounts under
 * a memory router (which resolves asynchronously) plus the error boundary the
 * route owns in production.
 */
export const playerProfilePage = {
  /**
   * Stub `GET /v1/players/:playerId`. The resolver is the profile BFF bundle
   * *every* card reads: count its calls to prove the page costs one request, not
   * one per card.
   */
  mockEndpoint(resolver: PlayerDetailResolver) {
    mockPlayerDetailEndpoint(server, resolver)
  },

  /**
   * Watch `GET /v1/players/:playerId/matches` — the paginated history endpoint
   * the profile must **never** call, since its Recent-matches card reads the six
   * rows the bundle already carries.
   *
   * Simply leaving it unstubbed proves nothing: `handlers.ts` registers a global
   * handler for it and `resetHandlers()` restores that between tests, so MSW
   * would answer the request rather than error on it. This overrides the global
   * handler with one that records the call, so a test can assert it was never
   * made.
   */
  spyOnMatchHistoryEndpoint(onRequest: () => void) {
    mockPlayerMatchesEndpoint(server, () => {
      onRequest()
      return HttpResponse.json({ items: [], page: 1, page_size: 25, total: 0 })
    })
  },

  render(overrides: Partial<PlayerProfileProps> = {}) {
    const props: PlayerProfileProps = {
      playerId: DEFAULT_PLAYER_ID,
      ...overrides,
    }

    renderWithRoutes(
      <ErrorBoundary
        fallbackRender={() => <div role="alert">Couldn’t load this player</div>}
      >
        <PlayerProfile {...props} />
      </ErrorBoundary>,
      { linkTargets: [MATCH_HISTORY_ROUTE] },
    )
  },

  within(container: Container = screen) {
    return scoped(container)
  },

  ...scoped(screen),
}
