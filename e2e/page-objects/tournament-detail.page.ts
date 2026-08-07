import { Locator, Page } from '@playwright/test'

import { EventEditorPage } from './tournament-detail-page/event-editor.page'
import { ScheduleTabPage } from './tournament-detail-page/schedule-tab.page'
import { TablesTabPage } from './tournament-detail-page/tables-tab.page'

/**
 * The **swiss** standings table's columns, by index, each with the name a screen reader
 * hears for it — `#`, `Player`, `W`, `L`, `Buc`, `Diff`, `GW`.
 *
 * The cells carry no test hooks of their own, so a column can only be addressed by
 * position, and a position is exactly the thing a *new column* silently changes. It did:
 * `Buc` was inserted between `L` and `Diff` when swiss standings started ranking by
 * Buchholz, which moved `GW` from index 5 to 6 — and index 5 still resolved, to game
 * difference, so an assertion reading "games won" quietly read the wrong number.
 *
 * Hence one map here rather than an `nth(…)` in each accessor, and hence the **name**
 * beside each index: a spec asserts that the header at each index is the column this map
 * claims (`swissStandingsHeader`), which turns the next inserted column into a red naming
 * the layout instead of a wrong number in a green run. The names are the `sr-only` words
 * the header spans carry, since the visible glyphs (`W`, `GW`) are not the accessible
 * name.
 */
export const SWISS_STANDINGS_COLUMNS = {
  rank: { index: 0, name: 'Rank' },
  player: { index: 1, name: 'Player' },
  wins: { index: 2, name: 'Wins' },
  losses: { index: 3, name: 'Losses' },
  buchholz: { index: 4, name: 'Buchholz' },
  gameDifference: { index: 5, name: 'Game difference' },
  gamesWon: { index: 6, name: 'Games won' },
} as const

/**
 * The tournament detail page (`/tournaments/$tournamentId`) — scoped to the
 * lifecycle round-robin spec's load-bearing surfaces: the header's lifecycle
 * button (Publish → Start tournament → End tournament, `LifecycleActions`) and the
 * confirm each of those edges now opens before it fires (`publishTournament`), an
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

  /** Switch to the **Tables** tab (the venue catalogue) and return its page object.
   *
   * Matched by a `^Tables` regex, not by an exact name: the trigger carries a count
   * badge, so its accessible name is "Tables 2", and the number is the very thing a
   * removal changes — an exact-name locator would stop resolving the tab the moment the
   * spec succeeded at what it came to do. */
  async openTables(): Promise<TablesTabPage> {
    await this.page.getByRole('tab', { name: /^Tables/ }).click()
    return new TablesTabPage(this.page)
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

  /** `draft → published`. Present only for the owner, only while `draft`.
   *
   * **`exact` is load-bearing here and only here.** `getByRole`'s name option is a
   * *substring* match by default, and the confirm this button opens carries the act's own
   * verb — `Publish the tournament` — which contains `Publish`. Measured against both
   * buttons on one page: the loose locator resolves **2**, the exact one **1**. So while
   * the dialog is open the loose locator is a strict-mode violation at best, and at worst
   * an assertion that means the header and silently checks the dialog.
   *
   * The other two edges do **not** need it and do not have it: `Start the tournament`
   * does not contain `Start tournament`, nor `End the tournament` contain `End
   * tournament` (the definite article breaks the substring). Don't "tidy" all three into
   * agreement — the asymmetry is the fact, not an oversight. */
  get publishButton(): Locator {
    return this.page.getByRole('button', { name: 'Publish', exact: true })
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

  /** The **confirm** button of `ConfirmIrreversibleActDialog` — the dialog every
   * one-way act opens before it is performed (ADR "a confirm prices an irreversible
   * act, a freeze explains an illegal one").
   *
   * Not scoped to anything: Radix portals an `AlertDialog` to the body, so a
   * header-scoped query finds nothing whether it opened or not. Addressed by testid
   * rather than by name because the name is the act's own verb and differs per edge
   * (`Publish the tournament`, `Start the tournament`, `End the tournament`) — one stable
   * hook, three sentences. */
  get confirmActButton(): Locator {
    return this.page.getByTestId('confirm-irreversible-act-confirm')
  }

  /** Publish the tournament: click the header's edge, then answer the confirm it opens.
   *
   * A method rather than two lines at each call site, for the same reason `openSchedule`
   * is one: the click and the confirm are **one act** a director performs, and the button
   * alone now moves nothing. A spec that clicked the edge and stopped would leave the
   * tournament in `draft` behind an unanswered dialog — which is exactly how this suite
   * went red when the confirms landed. */
  async publishTournament(): Promise<void> {
    await this.publishButton.click()
    await this.answerConfirm()
  }

  /** Go live: click **Start tournament**, then answer its confirm. The transition
   * (`POST …/transitions`) is fired by the confirm, so a spec awaiting that response
   * must arm its `waitForResponse` before calling this. */
  async startTournament(): Promise<void> {
    await this.startButton.click()
    await this.answerConfirm()
  }

  /** Archive: click **End tournament**, then answer its confirm. */
  async endTournament(): Promise<void> {
    await this.endButton.click()
    await this.answerConfirm()
  }

  /** Click the standing confirm and wait for the dialog to actually leave.
   *
   * The `detached` wait is the method's postcondition — "the act was answered *and* the
   * dialog is gone" — and it is not decoration: Radix animates the overlay out, and the
   * next thing a spec does after publishing is click a button on the page underneath it.
   * A `waitFor`, not an `expect`, so page objects stay assertion-free like the rest of
   * this suite. */
  private async answerConfirm(): Promise<void> {
    await this.confirmActButton.click()
    await this.confirmActButton.waitFor({ state: 'detached' })
  }

  // ----- events (Events tab) ------------------------------------------------

  /** **New event** — opens the editor sheet on a blank draft. Owner-only. */
  get newEventButton(): Locator {
    return this.page.getByRole('button', { name: 'New event' })
  }

  /** Open the event editor on a new draft and return its page object (the
   * child-composition variant, like `openSchedule`). A tournament with no events yet
   * offers the invitation from its empty state instead of the section header, so both
   * controls are accepted — they are one act. */
  async openNewEvent(): Promise<EventEditorPage> {
    await this.newEventButton
      .or(this.page.getByRole('button', { name: 'Add an event' }))
      .first()
      .click()
    return new EventEditorPage(this.page)
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

  /** **Every pool section** of a cut draw, so a spec can count them and read their order.
   * Addressed by the testid *pattern* rather than by pool id, because "how many pools the
   * draw was dealt across, in what order" is a fact about the draw that holds whatever the
   * pools are called or keyed by. Use `poolDraw` when the point is the key itself. */
  poolDraws(eventId: string): Locator {
    return this.drawPanel(eventId).getByTestId(/^pool-draw-/)
  }

  /** One pool section **by the pool's own id** — the uuid the server minted for it (ADR
   * 20260801), never a name.
   *
   * The seam that says the section on screen is keyed by the *server's* pool and not by
   * something the client re-derived: a spec reads the ids off the create response and
   * asks for them here, so a stack that keyed its sections any other way finds nothing. */
  poolDraw(eventId: string, poolId: string): Locator {
    return this.drawPanel(eventId).getByTestId(`pool-draw-${poolId}`)
  }

  /** One pool section of a cut draw, by the pool's displayed name ("Pool A").
   *
   * **`exact`** is load-bearing, not tidiness: `getByRole`'s name match is a substring
   * match by default, so "Pool 1" also selects "Pool 10" — and a ten-pool event is
   * precisely where this accessor gets used (`tournament-pool-order.spec.ts`). Without
   * it the locator quietly resolves to two sections and every assertion scoped through
   * it is measuring both. */
  poolDrawNamed(eventId: string, poolName: string): Locator {
    return this.poolDraws(eventId).filter({
      has: this.page.getByRole('heading', { name: poolName, level: 4, exact: true }),
    })
  }

  /** **Every pool's heading, in the order the page lays them out** — the draw's pool
   * order as a director reads it, top to bottom.
   *
   * Scoped *inside* the pool sections rather than to the panel's `h4`s at large, so the
   * bracket's own "Bracket" heading (a sibling `h4`, present for any draw with a
   * knockout stage) can never join the list and turn an ordering assertion into a
   * position-of-the-bracket assertion.
   *
   * Asserted with `toHaveText([...])`, which pins the count AND the order in one
   * statement — the only shape that can catch a draw rendering `Pool 1, Pool 10,
   * Pool 2 …`, the bug that pool ids being client-minted `p-1-…`, `p-10-…` used to
   * cause (`p-10-` sorts between `p-1-` and `p-2-`), and that ADR 20260801 ended by
   * making pool ids server-minted UUIDs sorted by an explicit `position`. */
  poolDrawHeadings(eventId: string): Locator {
    return this.poolDraws(eventId).getByRole('heading', { level: 4 })
  }

  /** One pool's entrant chips — the pool's *membership*, derived from its own fixtures
   * (ADR-0786) and listed in draw order. What the deal put in this pool, which is a
   * different fact from where the pool sits on the page: a draw dealt against the wrong
   * pool order renders the right headings over the wrong fields. */
  poolEntrants(eventId: string, poolName: string): Locator {
    return this.poolDrawNamed(eventId, poolName)
      // `exact` for the same reason as `poolDrawNamed`: "Entrants in Pool 1" is a
      // substring of "Entrants in Pool 10".
      .getByRole('list', { name: `Entrants in ${poolName}`, exact: true })
      .getByRole('listitem')
  }

  /** The **knockout bracket** — the fixtures belonging to no pool, rendered as
   * rounds-as-columns.
   *
   * For an `rr-then-ko` draw this must be present the moment the draw is cut, with its
   * sides still unknown: both stages are cut in one stroke (ADR 20260727), because an
   * `advance()` can only ever FILL a side of an existing fixture and so could never
   * bring a bracket into being later. Pools without this is not a selector problem — it
   * is the second stage genuinely missing. */
  bracket(eventId: string): Locator {
    return this.drawPanel(eventId).getByTestId('draw-unpooled')
  }

  /** One round-column of the bracket. Its fixtures are `<li>`s, so a spec counts them
   * with `getByRole('listitem')`; the highest round that exists is the final, which is
   * how a spec pins the bracket's SIZE (three rounds = eight slots = the smallest power
   * of two that holds `P × K` qualifiers). */
  bracketRound(eventId: string, round: number): Locator {
    return this.bracket(eventId).getByTestId(`bracket-round-${round}`)
  }

  // ----- swiss rounds (event card) ------------------------------------------

  /** The **swiss rounds** view — a flat, numbered list of rounds, which is what a
   * pool-less swiss draw's fixtures render as (ADR "swiss pre-cuts every round and pairs
   * each one on advance").
   *
   * A *different* block from `bracket`, and the difference is the point: both draw types
   * put their fixtures in `pool_id IS NULL`, and routing on that null alone rendered a
   * swiss draw through single-elimination's successor arithmetic — columns named back
   * from a Final ("Semifinals", "Quarterfinals") that a format eliminating nobody does
   * not have. So a spec asserts this is visible AND that `bracket` is absent; either
   * alone would pass against the view it is not about. */
  swissRounds(eventId: string): Locator {
    return this.drawPanel(eventId).getByTestId('draw-swiss-rounds')
  }

  /** One **paired** round's fixture list, by round number — present only once somebody
   * is seated in the round. Its fixtures are `<li>`s in position order, so a spec reads
   * them with `toHaveText([...])`, which pins the count, the order and the pairings in
   * one statement. */
  swissRound(eventId: string, round: number): Locator {
    return this.swissRounds(eventId).getByTestId(`swiss-round-${round}`)
  }

  /** One paired round's fixture lines. */
  swissRoundFixtures(eventId: string, round: number): Locator {
    return this.swissRound(eventId, round).getByRole('listitem')
  }

  /** One round's **bye line** — the entrant an odd field leaves out of it, named.
   *
   * A **sibling** of `swissRound`'s list, never an item in it, and the separation is the
   * point: a bye is the absence of a fixture (ADR-0786), so the byed entrant has no row
   * and cannot be an `<li>` without inventing the one the format does not have. That is
   * what lets a spec state the two halves of the fact separately — *this* line names them,
   * and `swissRound` does not, so "named as the bye" and "not seated in a pairing" are two
   * assertions rather than one ambiguous one.
   *
   * Present only for a **paired** round of an odd field: an unpaired round seats nobody,
   * and listing its whole field as byed would be the bug the derivation's third gate
   * exists to prevent. Plural ("Byes: a, b") when a draw has gone stale and more than one
   * entrant is unseated. */
  swissRoundBye(eventId: string, round: number): Locator {
    return this.swissRounds(eventId).getByTestId(`swiss-round-bye-${round}`)
  }

  /** One **forthcoming** round's line — the round that is already cut, holds its
   * `⌊n/2⌋` fixtures, and has nobody in it yet.
   *
   * The cut writes all `R` rounds at once, so a round past the first exists from the
   * moment the draw is dealt with both of every fixture's sides NULL. It is announced
   * (its match count, and what has to finish first) rather than drawn as rows of "TBD vs
   * TBD" — so the presence of THIS and the absence of `swissRound` are what "the later
   * rounds are present but not yet paired" means on screen. */
  swissRoundForthcoming(eventId: string, round: number): Locator {
    return this.swissRounds(eventId).getByTestId(
      `swiss-round-forthcoming-${round}`,
    )
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

  // ----- swiss standings (event card) ---------------------------------------

  /** A **swiss** event's standings — *one* table over the whole field, because swiss has
   * no pools (ADR "swiss pre-cuts every round and pairs each one on advance").
   *
   * A different section from `standingsPanel`, which groups its tables under pools: a
   * swiss event ranks everybody against everybody, and reading the pooled one would be a
   * spec that could not tell "the field is ranked" from "there are no pools to show". */
  swissStandings(eventId: string): Locator {
    return this.page.getByTestId(`swiss-standings-panel-${eventId}`)
  }

  /** **Every row of the swiss standings, in the order the page lays them out** — the
   * finishing order a director reads, top to bottom.
   *
   * Addressed by the testid *pattern* so the set is "the rows", whatever entries they
   * are; each row's own testid names the **server-minted entry id** it is for, which is
   * what `swissStandingRow` asks for and what makes "the table is in the server's order"
   * assertable rather than inferred from names. */
  swissStandingsRows(eventId: string): Locator {
    return this.swissStandings(eventId).getByTestId(/^standing-row-/)
  }

  /** One entry's row of the swiss standings, by the **entry id** the server minted. */
  swissStandingRow(eventId: string, entryId: string): Locator {
    return this.swissStandings(eventId).getByTestId(`standing-row-${entryId}`)
  }

  /** **Every cell of one entry's row, in column order** — for an assertion that pins the
   * whole line at once (`toHaveText([...])`), which is the only shape that can catch a
   * column having moved as well as a number being wrong. Column order and meaning:
   * `SWISS_STANDINGS_COLUMNS`. */
  swissStandingCells(eventId: string, entryId: string): Locator {
    return this.swissStandingRow(eventId, entryId).getByRole('cell')
  }

  /** One entry's cell in a named column — the accessor the single-column assertions go
   * through, so no spec writes an `nth(…)` of its own. */
  private swissStandingCell(
    eventId: string,
    entryId: string,
    column: { readonly index: number },
  ): Locator {
    return this.swissStandingCells(eventId, entryId).nth(column.index)
  }

  /** One entry's **wins** cell. This is the cell a **bye** is visible in at all: a bye is
   * scored as a win worth zero games (ADR "swiss standings add Buchholz"), so the byed
   * entrant's win shows up here and nowhere else — `GW` stays 0, which is the other half
   * of the same fact (`swissStandingGamesWon`). */
  swissStandingWins(eventId: string, entryId: string): Locator {
    return this.swissStandingCell(eventId, entryId, SWISS_STANDINGS_COLUMNS.wins)
  }

  /** One entry's **games won** cell. Zero for a bye, which is what stops a scheduling
   * artifact nobody played from lifting its holder over somebody who beat a real
   * opponent. */
  swissStandingGamesWon(eventId: string, entryId: string): Locator {
    return this.swissStandingCell(eventId, entryId, SWISS_STANDINGS_COLUMNS.gamesWon)
  }

  /** The standings table's **column header** at one index — what a spec asserts the name
   * of, to establish that the index a cell accessor reads is still the column it means.
   * See `SWISS_STANDINGS_COLUMNS` for why that guard exists. */
  swissStandingsHeader(eventId: string, column: { readonly index: number }): Locator {
    return this.swissStandings(eventId).getByRole('columnheader').nth(column.index)
  }

  /** The **two-stage** champion callout — the one a round-robin-then-knockout event
   * crowns (ADR 20260727).
   *
   * A different callout from `standingsChampion`, and deliberately so: that one belongs to
   * a complete **single-pool** round-robin and never renders for this format, while this
   * one names the **knockout final's** winner and never a pool leader. Reading the wrong
   * one would be a spec that could not tell "the bracket was played out" from "somebody
   * topped a pool". It appears only once BOTH stages are decided. */
  twoStageChampion(eventId: string): Locator {
    return this.page.getByTestId(`two-stage-champion-${eventId}`)
  }
}
