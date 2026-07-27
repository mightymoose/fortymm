import { Locator, Page } from '@playwright/test'

import { ScheduleTabPage } from './tournament-detail-page/schedule-tab.page'

/**
 * The tournament detail page (`/tournaments/$tournamentId`) — scoped to the
 * lifecycle round-robin spec's load-bearing surfaces: the header's lifecycle
 * button (Publish → Start tournament → End tournament, `LifecycleActions`), an
 * event card's Enter control and draw panel (both on the default **Events** tab),
 * the fixture's link into its materialized match, and the standings the completed
 * event derives.
 *
 * Raw selectors stay here; the spec reads intent-named locators. Locators are
 * user-facing (`getByRole`/`getByTestId`) and, where a page holds one per event,
 * named by the event so the accessor resolves the right card.
 */
export class TournamentDetailPage {
  constructor(private readonly page: Page) {}

  /** Open a tournament's detail page and return the instance. The Events tab is
   * the default, so no tab click is needed for the entry/draw/standings surfaces. */
  static async navigateTo(
    page: Page,
    tournamentId: string,
  ): Promise<TournamentDetailPage> {
    await page.goto(`/tournaments/${tournamentId}`)
    return new TournamentDetailPage(page)
  }

  /** Re-navigate to pick up server state changed out-of-band (a director-entry
   * made over the API), returning to a freshly-loaded Events tab. */
  async reload(tournamentId: string): Promise<void> {
    await this.page.goto(`/tournaments/${tournamentId}`)
  }

  /** Switch to the **Schedule** tab and return its page object (the
   * child-composition variant, like `DashboardPage.userMenu`). The tab is
   * plain component state, so no navigation happens — and once the tournament
   * is live the tab polls, so its locators converge without reloads. */
  async openSchedule(): Promise<ScheduleTabPage> {
    await this.page.getByRole('tab', { name: 'Schedule' }).click()
    return new ScheduleTabPage(this.page)
  }

  // ----- the hero (header) --------------------------------------------------

  /** The page's `h1` — the tournament's name. A spec asserts on it to establish
   * that the page RENDERED, which is what stops the venue absences below from
   * passing vacuously against a blank or crashed screen. */
  get title(): Locator {
    return this.page.getByRole('heading', { level: 1 })
  }

  /** The status pill in the hero ("Draft", "Live") — a second, independent sign
   * that the header really rendered. */
  get statusBadge(): Locator {
    return this.page.getByTestId('tournament-status-badge')
  }

  /** The hero's venue meta item: the pin icon and the venue line. **Absent
   * entirely** — not empty — for a tournament with no venue (CONTEXT.md,
   * "Venue"), which is a first-class state and never a "Venue TBD" placeholder. */
  get venueLine(): Locator {
    return this.page.getByTestId('tournament-venue-line')
  }

  /** The hero's venue map, **either branch**. `LocationMap` renders the Google map
   * when `VITE_GOOGLE_MAPS_API_KEY` is configured and a labelled text fallback
   * when it is not — and this stack is keyless, which is exactly the environment
   * where a "there is no map" assertion could pass for the wrong reason. Matching
   * both means the assertion is about the venue, not about the API key. */
  get venueMap(): Locator {
    return this.page
      .getByTestId('location-map')
      .or(this.page.getByTestId('location-map-fallback'))
  }

  // ----- lifecycle (header) -------------------------------------------------

  /** `draft → published`. Present only for the owner, only while `draft`. */
  get publishButton(): Locator {
    return this.page.getByRole('button', { name: 'Publish' })
  }

  /** `published → live` — the edge that materializes the draw into real matches. */
  get startButton(): Locator {
    return this.page.getByRole('button', { name: 'Start tournament' })
  }

  /** `live → archived`. Its appearance is how a spec confirms go-live landed —
   * the tournament is now `live`, so this is the only edge it offers. */
  get endButton(): Locator {
    return this.page.getByRole('button', { name: 'End tournament' })
  }

  /** The inline `Alert` a refused transition raises (e.g. Start on a stale draw). */
  get lifecycleNotice(): Locator {
    return this.page.getByTestId('lifecycle-notice')
  }

  // ----- entry (event card) -------------------------------------------------

  /** The self-registration **Enter** button on an event's card, by event name. */
  enterButton(eventName: string): Locator {
    return this.page.getByRole('button', { name: `Enter ${eventName}` })
  }

  /** The **Withdraw** button that replaces Enter once the signed-in player is in
   * the event — a spec asserts on it to prove the self-entry landed. */
  withdrawButton(eventName: string): Locator {
    return this.page.getByRole('button', { name: `Withdraw from ${eventName}` })
  }

  /** The roster `<ul>` for an event, named "Entrants in <event>". */
  entrantsList(eventName: string): Locator {
    return this.page.getByRole('list', { name: `Entrants in ${eventName}` })
  }

  // ----- draw (event card) --------------------------------------------------

  /** **Generate draw** — cuts an undrawn event's draw, by event name. */
  generateDrawButton(eventName: string): Locator {
    return this.page.getByRole('button', { name: `Generate draw for ${eventName}` })
  }

  /** The draw panel section for an event, scoping fixtures + the match link. */
  drawPanel(eventId: string): Locator {
    return this.page.getByTestId(`draw-panel-${eventId}`)
  }

  /** The "View match" deep-link a fixture grows once it materializes at go-live. */
  viewMatchLink(eventId: string): Locator {
    return this.drawPanel(eventId).getByRole('link', { name: /View match/ })
  }

  /** A materialized fixture's live match status ("In progress" → "Completed"). */
  fixtureMatchStatus(eventId: string): Locator {
    return this.drawPanel(eventId).getByTestId('fixture-match-status')
  }

  // ----- standings (event card) ---------------------------------------------

  /** The event's standings section — present only once the round-robin has a
   * cut draw (before that, `event.results` is null and nothing renders). */
  standingsPanel(eventId: string): Locator {
    return this.page.getByTestId(`standings-panel-${eventId}`)
  }

  /** The champion callout — shown only for a **complete, single-pool** event, so
   * its presence *is* the "there is a rank-#1 champion" fact. Its text carries the
   * champion's username. */
  standingsChampion(eventId: string): Locator {
    return this.page.getByTestId(`standings-champion-${eventId}`)
  }

  /** A pool's standings table, by pool id — its rows are in finishing order, so
   * the first data row is rank 1. */
  poolStandings(poolId: string): Locator {
    return this.page.getByTestId(`pool-standings-${poolId}`)
  }
}
