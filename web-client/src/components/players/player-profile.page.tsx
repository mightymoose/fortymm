import { HttpResponse } from 'msw'
import { ErrorBoundary } from 'react-error-boundary'

import { MATCH_DETAIL_ROUTE } from '@/components/matches/match-row-link/match-row-link.page'
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
import { confidenceCardDisplayPage } from './player-profile/confidence-card/confidence-card-fetcher/confidence-card-display.page'
import {
  headToHeadCardDisplayPage,
  NEW_MATCH_ROUTE,
} from './player-profile/head-to-head-card/head-to-head-card-fetcher/head-to-head-card-display.page'
import {
  leaguesCardDisplayPage,
  PROFILE_ROUTE,
} from './player-profile/leagues-card/leagues-card-fetcher/leagues-card-display.page'
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
  /** The Rating confidence card's skeleton, while the bundle is pending. Named
   * "Loading confidence", not "Loading rating confidence" — the latter would also
   * match `queryStandingLoading`'s `/loading rating/i` and break it. */
  queryConfidenceLoading() {
    return container.queryByRole('status', { name: /loading confidence/i })
  },
  /** The Head-to-head card's skeleton, while the bundle is pending. */
  queryHeadToHeadLoading() {
    return container.queryByRole('status', { name: /loading head-to-head/i })
  },
  /**
   * The body's cards in **DOM order**, by their headings — top to bottom, which
   * on this page is also the order a phone reads, a keyboard tabs and a screen
   * reader announces (the profile is one column at every width, and the order is
   * DOM order, not a CSS `order:`).
   *
   * This is what makes the viewer-dependent order (ADR-0915) honestly testable in
   * jsdom, which has no layout engine and would see straight through a CSS
   * reordering.
   *
   * Only `<h2>`s **inside `.player-profile__body`**: the rating panel's overline
   * in the hero is an `h2` too, and the cards' *skeletons* deliberately title
   * themselves with a `<span>` rather than a heading — so a mid-load call answers
   * with the cards that have actually painted, not with a phantom order.
   */
  getCardOrder(): string[] {
    const headings: HTMLElement[] = container.getAllByRole('heading', {
      level: 2,
    })
    return headings
      .filter((heading) => heading.closest('.player-profile__body'))
      .map((heading) => heading.textContent?.trim() ?? '')
  },

  /**
   * Each painted card as `[heading, card-root class]`, in DOM order.
   *
   * The desktop grid (`player-profile.css`, `@media (min-width: 960px)`) puts the
   * cards into two columns by **explicit placement keyed on these class names** —
   * `.rating-chart` and `.recent-matches` into the wide column, `.career-card`,
   * `.confidence-card`, `.leagues-card` and `.head-to-head` into the narrow one —
   * because the DOM order is the phone's, and viewer-dependent, so it cannot also
   * be the desktop reading order.
   *
   * That makes the class on each card's root a **contract with the stylesheet**,
   * not decoration: rename one and the card silently falls out of its column into
   * whatever auto-placement makes of it. jsdom has no layout engine, so a test
   * cannot see the columns — it CAN see the hooks, which is what this exposes.
   * The columns themselves are a browser-only fact.
   */
  getCardPlacementHooks(): [heading: string, cardClass: string][] {
    const headings: HTMLElement[] = container.getAllByRole('heading', {
      level: 2,
    })
    return headings
      .filter((heading) => heading.closest('.player-profile__body'))
      .map((heading) => {
        const root = heading.closest('.player-profile__section')
        const cardClass = [...(root?.classList ?? [])].find(
          (name) => name !== 'player-profile__section',
        )
        return [heading.textContent?.trim() ?? '', cardClass ?? '(none)']
      })
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
  // …and confidence's are all confidence-prefixed (`getConfidenceLevel`,
  // `getConfidenceInterval`, `queryConfidenceCard`), for the same reason.
  ...confidenceCardDisplayPage.within(container),
  // …and the Leagues card's are league-prefixed (`getLeagueRows`,
  // `getSelectedLeagueName`, `getLeagueRating`, `getLeagueHref`). This is the
  // page's league *switcher*, so `getSelectedLeagueName()` is the answer to
  // "which ladder are the hero's numbers about?".
  ...leaguesCardDisplayPage.within(container),
  // …and the Head-to-head card's are all card-scoped (`queryVersusLine`,
  // `queryStartMatchLink`, `getFrequentOpponentNames`). This is the page's
  // viewer-aware card: `getHeadToHeadTitle()` is the answer to "whose profile does
  // the page think this is?" — "Head-to-head" on somebody else's, "Frequent
  // opponents" on your own.
  ...headToHeadCardDisplayPage.within(container),
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
      // Three link targets: the Recent-matches footer opens the full history,
      // every Leagues-card row links back to *this* profile with a different
      // league selected (the switcher, ADR-0915), and the Head-to-head card's
      // never-met CTA opens match creation with this player already picked.
      {
        linkTargets: [
          MATCH_HISTORY_ROUTE,
          MATCH_DETAIL_ROUTE,
          PROFILE_ROUTE,
          NEW_MATCH_ROUTE,
        ],
      },
    )
  },

  within(container: Container = screen) {
    return scoped(container)
  },

  ...scoped(screen),
}
