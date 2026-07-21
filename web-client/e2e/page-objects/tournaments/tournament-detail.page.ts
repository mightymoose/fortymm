import { expect, type Locator, type Page } from '@playwright/test'

import {
  EVENT,
  TOURNAMENT_ID,
  TournamentsStore,
  type TournamentsStoreOptions,
} from './tournaments-store'

/** The three lifecycle buttons, by the label the user reads — one per edge of
 * `draft → published → live → archived` (ADR-0017). Spelled out here rather than
 * imported from the app's `LIFECYCLE_EDGE` table on purpose: a page object that
 * read the labels out of the component could not notice them changing. */
export type LifecycleLabel = 'Publish' | 'Start tournament' | 'End tournament'

/** The status pill's copy — likewise the user's words, not the wire's. */
export type StatusLabel = 'Draft' | 'Published' | 'Live' | 'Archived'

/**
 * Page object for the tournament detail page's **Events tab** (the default tab,
 * so no navigation beyond the URL).
 *
 * Every locator is keyed on the event NAME, because the tab is a list of
 * near-identical cards: a bare `getByRole('button', { name: 'Enter' })` would be
 * ambiguous the moment a second singles event exists, and a count assertion not
 * scoped to a card would happily match a sibling's identical `2 / 64`.
 */
export class TournamentDetailPage {
  constructor(private readonly page: Page) {}

  /** Install the stateful stub, load the page, and wait for the Events tab to be
   * really on screen. That last wait is load-bearing: every "there is no Enter
   * control here" assertion in the spec passes *vacuously* against a page that
   * has not rendered yet. */
  static async navigateTo(page: Page, options: TournamentsStoreOptions = {}) {
    const store = new TournamentsStore(options)
    await store.install(page)
    await page.goto(`/tournaments/${TOURNAMENT_ID}`)

    const pom = new TournamentDetailPage(page)
    await expect(pom.eventCard(EVENT.JOURNEY)).toBeVisible()
    return { pom, store }
  }

  /** One event's row card. The stretched open-target button is a *sibling* of
   * the `Card` (that is what keeps it out of the entrants list and off the Enter
   * control), so it is deliberately NOT inside this locator. */
  eventCard(eventName: string): Locator {
    return this.page.locator('[data-slot=card]').filter({ hasText: eventName })
  }

  // ----- the lifecycle header (ADR-0017) -----------------------------------

  /** The status pill in the detail hero. Its text IS the status, in the words the
   * user reads ("Published", "Live") — never the wire's `published`. */
  get statusBadge(): Locator {
    return this.page.getByTestId('tournament-status-badge')
  }

  /** The header's lifecycle button for one edge. Exactly one is offered at a
   * time, and only to an owner. */
  lifecycleButton(label: LifecycleLabel): Locator {
    return this.page.getByRole('button', { name: label, exact: true })
  }

  /** ANY lifecycle button — the locator for the two states in which the header
   * must offer *none*: an archived tournament (no edge out of it), and a viewer
   * (every transition is owner-only). `toHaveCount(0)` against a per-edge locator
   * would only prove the absence of the one edge it named. */
  get anyLifecycleButton(): Locator {
    return this.page.getByRole('button', {
      name: /^(Publish|Start tournament|End tournament)$/,
    })
  }

  /** The header's inline **refusal** — where a rejected transition is reported now
   * (#786): an `Alert` beside the button that was clicked, not a toast. It carries the
   * client's title and, beneath it, the server's own sentence — which for a refused
   * **Start tournament** is the one that *names the events* whose draws are missing or
   * stale, i.e. the work list the director acts on. A toast would take that away after
   * four seconds. */
  get lifecycleNotice(): Locator {
    return this.page.getByTestId('lifecycle-notice')
  }

  /** Assert the pill reads exactly this status, and that the header offers
   * exactly the button that status has an edge for — the two halves of one claim
   * ("the view moved"), which drift apart if a spec only ever checks the badge. */
  async expectLifecycle(status: StatusLabel, action: LifecycleLabel | 'none') {
    await expect(this.statusBadge).toHaveText(status)
    if (action === 'none') {
      await expect(this.anyLifecycleButton).toHaveCount(0)
      return
    }
    await expect(this.lifecycleButton(action)).toBeVisible()
    await expect(this.anyLifecycleButton).toHaveCount(1)
  }

  // ----- the draw panel (ADR-0786) -----------------------------------------
  //
  // Every locator here is scoped to ONE event card, because the tab renders a draw panel
  // per event and the pools inside them are all called "Pool A": an unscoped
  // `getByRole('region', { name: 'Pool A' })` would match two different events' pools and
  // (rightly) throw on the ambiguity — or, worse, assert one event's draw and call it
  // the other's.
  //
  // They are addressed by their **accessible names**, not by test ids, wherever the
  // component gives them one. That is deliberate: the whole panel is a screen-reader
  // artefact (a pool's roster is a named list, a round is a named list, a fixture is a
  // list item that says "vs" out loud), so a locator that went around the accessibility
  // tree would be testing a draw that a blind director cannot read.

  /** One event's draw panel — the `<section>` headed "Draw" on its card. */
  drawPanel(eventName: string): Locator {
    return this.eventCard(eventName).getByRole('region', { name: 'Draw' })
  }

  /** The panel's designed EMPTY state: an event with no draw cut. Not a spinner and not
   * an error — the state every event is born in. */
  drawEmpty(eventName: string): Locator {
    return this.eventCard(eventName).getByTestId('draw-empty')
  }

  /** The draw's three verbs, owner-only and named per event (the tab shows one panel per
   * card, so a bare "Generate draw" would be four identical buttons). */
  generateDrawButton(eventName: string): Locator {
    return this.page.getByRole('button', {
      name: `Generate draw for ${eventName}`,
    })
  }

  recutDrawButton(eventName: string): Locator {
    return this.page.getByRole('button', { name: `Re-cut draw for ${eventName}` })
  }

  deleteDrawButton(eventName: string): Locator {
    return this.page.getByRole('button', { name: `Delete draw for ${eventName}` })
  }

  /** The panel's inline **refusal** — the `Alert` where the click was, carrying the
   * server's own sentence (a 422 names what the director must change). Addressed by the
   * testid prefix because the id carries the event's id, which a spec has no business
   * knowing. */
  drawNotice(eventName: string): Locator {
    return this.eventCard(eventName).locator('[data-testid^="draw-notice-"]')
  }

  /** One pool of a cut draw, by the name the event gives it ("Pool A"). */
  poolDraw(eventName: string, poolName: string): Locator {
    return this.eventCard(eventName).getByRole('region', { name: poolName })
  }

  /** The chips naming who the draw dealt into a pool — its membership, which nothing
   * stores: it is derived from the pool's own fixtures (ADR-0786). */
  poolEntrants(eventName: string, poolName: string): Locator {
    return this.poolDraw(eventName, poolName)
      .getByRole('list', { name: `Entrants in ${poolName}` })
      .getByRole('listitem')
  }

  /** One round's fixtures within a pool, in position order. An odd pool's rounds hold
   * FEWER of them — the player drawn against the phantom seat sits that round out, and
   * that absence is the entire representation of a bye. */
  roundFixtures(eventName: string, poolName: string, round: number): Locator {
    return this.poolDraw(eventName, poolName)
      .getByRole('list', { name: `Round ${round} fixtures in ${poolName}` })
      .getByRole('listitem')
  }

  /** Every fixture line of one event's draw, across all its pools — for counting the
   * whole draw, and for sweeping it for words that must never appear on one ("bye"). */
  fixtureLines(eventName: string): Locator {
    return this.drawPanel(eventName).locator('[data-testid^="fixture-line-"]')
  }

  // ----- the standings (ADR-0788) ------------------------------------------
  //
  // The results block below the fixtures on a round-robin card: a table per pool (in the
  // server's finishing order — never re-sorted here), and a champion once the event is
  // decided. Scoped to one event card, like the draw, because the tab renders one per
  // event and every "Standings" region / "Pool A" table would otherwise be ambiguous.

  /** One event's results block — the `<section>` headed "Standings" on its card. Absent
   * (count 0) for an event with no results: an uncut or non-round-robin event stands
   * nothing. */
  standingsPanel(eventName: string): Locator {
    return this.eventCard(eventName).getByRole('region', { name: 'Standings' })
  }

  /** One pool's standings table, by the pool name in its accessible label — the whole
   * point being that a screen reader reads a real `<table>` by column, so this goes
   * through the accessibility tree, not a test id. */
  standingsTable(eventName: string, poolName: string): Locator {
    return this.eventCard(eventName).getByRole('table', {
      name: `Standings for ${poolName}`,
    })
  }

  /** The player names down one pool's table, top to bottom — the ORDER the server settled
   * and the FE renders untouched (ADR-0788). The Player cell is the second cell of each
   * body row (`<th scope=col>`s are `columnheader`s, not rows here). */
  standingsRowNames(eventName: string, poolName: string): Locator {
    return this.standingsTable(eventName, poolName)
      .locator('tbody tr')
      .locator('td:nth-child(2)')
  }

  /** The champion callout on one card — shown only for a complete, single-champion event.
   * Addressed by the testid prefix (the id carries the event's id, which a spec has no
   * business knowing), scoped to the card. Absent when there is no single champion. */
  standingsChampion(eventName: string): Locator {
    return this.eventCard(eventName).locator('[data-testid^="standings-champion-"]')
  }

  // ----- the event card's entry control ------------------------------------

  enterButton(eventName: string): Locator {
    return this.page.getByRole('button', { name: `Enter ${eventName}` })
  }

  /** The closed-window notice on one event card — the designed state the entry
   * control renders instead of a button when the tournament is not `published`.
   * Scoped to the card: every event card shows one, so an unscoped testid would
   * match four. */
  registrationNotice(eventName: string): Locator {
    return this.eventCard(eventName).getByTestId('registration-notice')
  }

  /** The full-event notice on one card (#783) — what an event at `max_players`
   * renders where its Enter button would have been. */
  fullNotice(eventName: string): Locator {
    return this.eventCard(eventName).getByTestId('event-full-notice')
  }

  /** The rating-ineligible notice on one card (#783): the rule that refused this
   * player, and the rating it judged them on. */
  ineligibleNotice(eventName: string): Locator {
    return this.eventCard(eventName).getByTestId('ineligible-notice')
  }

  /** Every button inside one event card **except the draw panel's** — the locator the
   * "no *disabled* Enter" claim actually needs. `enterButton()` is keyed on the
   * accessible name, so it proves only that a button *called* "Enter X" is absent; this
   * proves the card offers no ENTRY control at all beyond its own open-target overlay
   * (which is a sibling of the card, not inside it — see `eventCard`). ADR-0015: hide
   * the affordance, never disable it.
   *
   * The draw's verbs (Generate / Re-cut / Delete, ADR-0786) live inside the same card
   * and are excluded on purpose: they are a *director's* controls, gated on the
   * tournament's `can_edit` rather than on anything about entry, and a full or
   * rating-ineligible event is exactly as drawable as any other. Folding them in would
   * make this locator quietly assert "an owner may not cut a draw for a full event",
   * which is not true and is not what any of its callers mean. */
  cardButtons(eventName: string): Locator {
    return this.eventCard(eventName).locator(
      'button:not([data-testid^="draw-panel-"] button)',
    )
  }

  withdrawButton(eventName: string): Locator {
    return this.page.getByRole('button', { name: `Withdraw from ${eventName}` })
  }

  /** The roster `<ul>`. Absent (count 0) in the `empty` and `entry-closed`
   * states, which render a paragraph instead. */
  entrantsList(eventName: string): Locator {
    return this.page.getByRole('list', { name: `Entrants in ${eventName}` })
  }

  /** The roster's rows, in the order the card shows them — the entrant chips,
   * then the `+N more` tail when it is truncating. Order is the point: the
   * signed-in player's own chip is pinned to the front (#781), so `.first()` is
   * where an entered player must be able to find themselves. */
  entrantItems(eventName: string): Locator {
    return this.entrantsList(eventName).getByRole('listitem')
  }

  /** The `+N more` tail — how many entrants the card is *not* showing. Text, not
   * a control: the card's stretched overlay owns the only click here. */
  truncationTail(eventName: string): Locator {
    return this.entrantsList(eventName).getByText(/^\+\d+ more$/)
  }

  /** Every `Unrated` mark in one roster — the entrants who hold no rating on the
   * tournament's ladder (ADR-0783 §3), and therefore passed every rating rule to
   * get in. The locator is the **word**, not a class or a colour, on purpose: that
   * is the only channel a colour-blind director, a greyscale screen and a screen
   * reader all share, so it is the one worth failing over. */
  unratedTags(eventName: string): Locator {
    return this.entrantsList(eventName).getByText('Unrated', { exact: true })
  }

  /** The chips of one roster that carry the `Unrated` mark — so a spec can assert
   * *who* is marked, not merely how many. `getByText` alone would be satisfied by
   * the word landing on the wrong player. */
  unratedEntrantItems(eventName: string): Locator {
    return this.entrantItems(eventName).filter({ hasText: 'Unrated' })
  }

  /** The full-card overlay that opens the editor. Its accessible name is
   * `Edit {event}` for an owner, `View {event}` otherwise. */
  openEditorOverlay(eventName: string): Locator {
    return this.page.getByRole('button', { name: `Edit ${eventName}` })
  }

  /**
   * Open one event's editor by clicking its card — **on the header**, where a director
   * would.
   *
   * Not at the overlay's geometric centre, which is where a bare `.click()` goes: the
   * open target is a `z-0` sibling stretched under the card, and the card raises its own
   * *controls* above it (`relative z-10`) — the Enter button, and the whole **draw
   * panel**, whose Generate / Re-cut / Delete would otherwise never receive a click. So
   * on a DRAWN card — a tall one — the centre of the overlay lands inside the pools
   * scaffold, and the click does nothing.
   *
   * That is the correct behaviour, not a bug to route around: a fixture line is not a
   * link to the event editor. It is simply why this click is positioned.
   */
  async openEditor(eventName: string) {
    await this.openEditorOverlay(eventName).click({ position: { x: 30, y: 20 } })
  }

  /** The event editor — a Sheet, i.e. a `role="dialog"`. The one thing clicking
   * Enter must NOT do. */
  get eventEditor(): Locator {
    return this.page.getByRole('dialog')
  }

  // ----- the event editor (#783 QA: the rule builder, and the refused save) ----

  /** The Events tab's "New event" action — owner-only, and the way into the editor
   * on a draft event that exists nowhere else yet. */
  get newEventButton(): Locator {
    return this.page.getByRole('button', { name: 'New event' })
  }

  /** The editor's own Save/Create action. */
  get saveEventButton(): Locator {
    return this.page.getByRole('button', { name: /Create event|Save changes/ })
  }

  /** One of the editor's four section tabs. */
  editorTab(name: 'Basics' | 'Eligibility' | 'Match settings' | 'Table pools'): Locator {
    return this.page.getByRole('tab', { name })
  }

  /** The Eligibility tab's "Add rule" — the SectionHeader's action, exactly. Not a
   * `/Add (a )?rule/`: an event with no rules also renders an empty state offering
   * "Add a rule", and a loose pattern matches both (strict mode rightly refuses to
   * guess which). */
  get addRuleButton(): Locator {
    return this.page.getByRole('button', { name: 'Add rule', exact: true })
  }

  /** The rule builder's controls. There is one rule row in every spec below, so
   * these are unscoped by design — a second row would (rightly) make them
   * ambiguous rather than silently pick the first. */
  get ruleOperator(): Locator {
    return this.page.getByRole('combobox', { name: 'Operator' })
  }

  get ruleValue(): Locator {
    return this.page.getByLabel('Value')
  }

  get ruleLowerBound(): Locator {
    return this.page.getByLabel('Lower bound')
  }

  get ruleUpperBound(): Locator {
    return this.page.getByLabel('Upper bound')
  }

  /** The red messages under a rule's value control(s) — what the form says about a
   * rule it refuses to send. */
  get ruleErrors(): Locator {
    return this.page.getByTestId('predicate-error')
  }

  /** The rule row's Remove control. On a phone it is the row's last *line* rather
   * than its last *column* — and it used to be off the right-hand edge of the screen
   * entirely, along with the Value box it belongs to. */
  get removeRuleButton(): Locator {
    return this.page.getByRole('button', { name: 'Remove rule' })
  }

  /** One rule row — the `Value` control lives in its third column (fourth *line*, on
   * a phone). */
  get ruleRow(): Locator {
    return this.page.getByTestId('predicate-row')
  }

  /** A red message under one of the Basics fields (the `Field` row's error hint) —
   * the counterpart of `ruleErrors` on the other tab. Keyed on the text the organizer
   * reads, since that is the whole claim: they were told, here, before anything was
   * sent. */
  basicsError(message: string): Locator {
    return this.eventEditor.getByText(message)
  }

  /** The event's player-limit box (Basics). **Clearing it authors `max_players: null` —
   * an uncapped event** (ADR-0935), which is a valid save; it used to author
   * `max_players: 0` (`Number('')` is `0`), an event admitting nobody, which the server
   * refused with a 422 the editor threw away. Typing `9999999999` into it authors a
   * value the `Integer` column cannot hold, which the server answered with a **500** —
   * both bounds now live in the form's schema. */
  get playerLimitInput(): Locator {
    return this.page.getByLabel(/Player limit/)
  }

  get entryFeeInput(): Locator {
    return this.page.getByLabel(/Entry fee/)
  }

  /** The Basics tab's time-slot row — the three boxes that were still laid out in three
   * fixed columns after the rule row had been fixed, and so still ran off the right-hand
   * edge of a phone (the End time rendered at `x=339..467` on a 375px screen). */
  get slotDateInput(): Locator {
    return this.eventEditor.getByLabel('Date')
  }

  get slotStartInput(): Locator {
    return this.eventEditor.getByLabel('Start')
  }

  get slotEndInput(): Locator {
    return this.eventEditor.getByLabel('End')
  }

  /** The editor's scrolling body. A phone spec scrolls it VERTICALLY to reach the foot
   * of the form (that is the design) and asserts it never scrolls SIDEWAYS (that is the
   * bug) — see `expectNoHorizontalScroll`. */
  get editorBody(): Locator {
    return this.page.getByTestId('event-editor-body')
  }

  /** The editor's report of a REFUSED SAVE: the alert that keeps the failure beside
   * the unsaved work, instead of a toast that leaves in four seconds — or, as it
   * was, instead of nothing at all. */
  get saveFailure(): Locator {
    return this.page.getByTestId('event-editor-error')
  }

  /** The event's name field, in Basics — the proof that a refused save kept the
   * organizer's typing rather than binning it. */
  get eventNameInput(): Locator {
    return this.page.getByLabel(/Event name/)
  }

  /** Pick an operator from the rule row's listbox. */
  async chooseOperator(label: string) {
    await this.ruleOperator.click()
    await this.page.getByRole('option', { name: label }).click()
  }

  // ----- the editor, with a draw standing (ADR-0786) ------------------------
  //
  // Two of the editor's controls freeze once an event's draw is cut — its **draw type**
  // (the strategy that dealt the fixtures) and its **set of pools** (each fixture names
  // one by id). They are DISABLED WITH A REASON, never hidden: unlike the viewer's
  // missing buttons, these are one deleted draw away from working, so hiding them would
  // hide the way out along with the control (ADR-0015 forbids the *unexplained* dead
  // end — the reason in text is what makes this one not that).

  /** The Basics tab's draw-type select. Present-but-disabled under a cut draw, so it is
   * located by role: the state under test is a control that is there, readable, and
   * dead. */
  get drawTypeSelect(): Locator {
    return this.page.getByRole('combobox', { name: 'Draw type' })
  }

  /** The Table pools tab's one explanation of the freeze — the `Alert` that both the Add
   * button and every Remove button point at with `aria-describedby`. */
  get poolsFrozenNotice(): Locator {
    return this.page.getByTestId('pools-frozen-notice')
  }

  get addPoolButton(): Locator {
    return this.page.getByRole('button', { name: 'Add pool' })
  }

  /** Every pool's trash button. Plural on purpose: "the removes are all dead" is the
   * claim, and a locator that named one pool could only ever prove it of that one. */
  get removePoolButtons(): Locator {
    return this.page.getByRole('button', { name: 'Remove pool' })
  }

  /** One pool's card in the editor, by position — the pools are a list, and the editor
   * names them only by an editable text box. */
  poolCard(index: number): Locator {
    return this.page.getByTestId('pool-card').nth(index)
  }

  /** A table chip inside one pool card ("T3"), which toggles that table into the pool.
   * **Still live with a draw standing** — that is the point of freezing only the pool
   * *set*: a table breaks mid-event and the director has to be able to record it without
   * destroying a correct draw. */
  poolTableChip(poolIndex: number, label: string): Locator {
    return this.poolCard(poolIndex).getByRole('button', { name: label, exact: true })
  }

  /** One pool's name box. **The only control on this tab that can author a pool the
   * server refuses**: the id and the default name are minted, but this box can be
   * emptied — and `Pool.name` is `min_length=1`. Scoped to the card, because the pools
   * are a list of identically-labelled boxes. */
  poolNameInput(index: number): Locator {
    return this.poolCard(index).getByLabel('Pool name')
  }

  /** The red messages under the pool name boxes — the Table pools counterpart of
   * `ruleErrors` and `basicsError`. Plural: which card is red is the claim. */
  get poolNameErrors(): Locator {
    return this.page.getByTestId('pool-name-error')
  }

  /**
   * The element a control POINTS AT with `aria-describedby` — i.e. the sentence a screen
   * reader actually reads out when it lands on it, as opposed to whatever text happens
   * to sit near it on screen.
   *
   * It is the only channel a **disabled** control has: it is not focusable, and it holds
   * no tooltip anyone will ever hear. A reason rendered under a dead trigger and not
   * pointed at is a reason for sighted directors only — which is exactly what the
   * draw-type select was doing while the pools section, one tab over, wired the identical
   * freeze correctly.
   *
   * Resolves to a locator that matches NOTHING when the control describes nothing, so an
   * assertion on it fails loudly rather than passing vacuously.
   */
  async describedBy(control: Locator): Promise<Locator> {
    const id = await control.getAttribute('aria-describedby')
    return this.page.locator(id ? `[id="${id}"]` : '#describes-nothing')
  }

  /** The tournament-level "Entries" hero stat: the sum of every event's derived
   * count. It is a `Card` like the event rows are, so it is identified as "the
   * card that says Entries but is not an event card" — event cards all carry a
   * Time slot column. */
  get heroEntries(): Locator {
    return this.page
      .locator('[data-slot=card]')
      .filter({ hasText: 'Entries' })
      .filter({ hasNotText: 'Time slot' })
  }

  /** Toasts — the app's error channel. The happy journey must raise none. */
  get toasts(): Locator {
    return this.page.locator('[data-sonner-toast]')
  }

  /** Assert an event card's `entered / max_players` numerals, scoped to the card
   * so a sibling event's identical figures cannot satisfy it. */
  async expectEntryCount(eventName: string, entered: number, max: number) {
    await expect(this.eventCard(eventName)).toContainText(
      new RegExp(`${entered}\\s*/\\s*${max}`),
    )
  }

  /** The capacity caption under one card's fill bar (#783): how many places the event
   * has left, that it is full, or — for an uncapped event (ADR-0935) — that it has no
   * limit at all. The numeral above it says what is *in* the event; this says what is
   * left of it. */
  capacityNote(eventName: string): Locator {
    return this.eventCard(eventName).getByTestId('capacity-remaining')
  }

  // ----- the Schedule tab & its solve strip (ADR "the schedule is solved") ---

  /** Open the Schedule tab and wait for its strip to really be on screen — every
   * "the strip says X" assertion passes vacuously against a tab that has not
   * rendered yet. */
  async openScheduleTab() {
    await this.page.getByRole('tab', { name: 'Schedule' }).click()
    await expect(this.solveStrip).toBeVisible()
  }

  /** The solve strip — what the latest run of the placement solver has to say. */
  get solveStrip(): Locator {
    return this.page.getByTestId('solve-strip')
  }

  /** One of the strip's five designed states — present iff the strip is in it. */
  solveStripState(
    state: 'none' | 'solving' | 'succeeded' | 'infeasible' | 'failed',
  ): Locator {
    return this.page.getByTestId(`solve-strip-${state}`)
  }

  /** The calm "overrunning" badge — present only on a succeeded solve whose live
   * day ran past its planned window (ADR "the solver stops wedging"), never on a
   * normal in-window success. */
  get overrunningBadge(): Locator {
    return this.page.getByTestId('solve-strip-overrunning')
  }

  /** The specific dated reason row on an infeasible solve carrying a `past_window`
   * arm (a wholly-past window, ADR "a past day is named, not disguised") — present
   * only when that reason is in `infeasibility_reasons`, never on a generic
   * capacity infeasibility. */
  get pastWindowMessage(): Locator {
    return this.page.getByTestId('solve-strip-past-window')
  }

  /** The owner's Run-scheduler button — absent, not disabled, for a viewer. */
  get runScheduler(): Locator {
    return this.page.getByTestId('run-scheduler')
  }

  /** The inline run refusal (the strip's only error surface — never a toast). */
  get runSchedulerNotice(): Locator {
    return this.page.getByTestId('run-scheduler-notice')
  }

  // ----- the schedule boards (Gantt / player timeline, chore 2a) -------------

  /** The tab's view toggle — List | Gantt | Player timeline. Its items are
   * radios (radix single ToggleGroup). */
  get scheduleViewToggle(): Locator {
    return this.page.getByTestId('schedule-view-toggle')
  }

  async setScheduleView(label: 'List' | 'Gantt' | 'Player timeline') {
    await this.scheduleViewToggle.getByRole('radio', { name: label }).click()
  }

  /** The Gantt board (rows = tables), and its labelled scrollable chart region
   * — the region is the keyboard-focusable scroll container (#1035 family). */
  get ganttBoard(): Locator {
    return this.page.getByTestId('schedule-gantt')
  }

  get ganttRegion(): Locator {
    return this.page.getByRole('region', { name: 'Schedule by table' })
  }

  /** One table's Gantt row, by catalogue id (`t1` …). */
  ganttRow(tableId: string): Locator {
    return this.page.getByTestId(`gantt-row-${tableId}`)
  }

  /** The player-timeline board (rows = entrants) and its scroll region. */
  get playerTimelineBoard(): Locator {
    return this.page.getByTestId('schedule-player-timeline')
  }

  get playerRegion(): Locator {
    return this.page.getByRole('region', { name: 'Schedule by player' })
  }

  /** Every placed fixture's bar, in either board — focusable buttons. */
  get timelineBars(): Locator {
    return this.page.locator('[data-testid^="timeline-bar-"]')
  }

  /** One fixture's bar, by id — for reading a single bar's tier or its
   * accessible name (where the call marker rides). */
  timelineBar(fixtureId: string): Locator {
    return this.page.getByTestId(`timeline-bar-${fixtureId}`)
  }

  /** The bars whose tier is **called** — pinned promises (ADR "the schedule is
   * solved; the call is pinned"), as the `data-tier` hook encodes it. While
   * LIVE this tier is rare on purpose: materialization (#788) makes a called
   * fixture's match `in_progress` (tier `started`), and the promise rides the
   * bar's marker/aria instead. */
  get calledBars(): Locator {
    return this.page.locator('[data-testid^="timeline-bar-"][data-tier="called"]')
  }

  /** The LIST rows' called-at badges (`Called 09:00`) and, past the first call,
   * their `notified n×` counters — the list-view half of the same marker. */
  get calledBadges(): Locator {
    return this.page.locator('[data-testid^="schedule-called-"]')
  }

  get notifiedMarkers(): Locator {
    return this.page.locator('[data-testid^="schedule-notified-"]')
  }

  /** The `est` marks on the list's scheduled-but-still-estimate rows. */
  get estMarks(): Locator {
    return this.page.locator('[data-testid^="schedule-est-"]')
  }

  /** The boards' designed "no placements yet" prompt. */
  get boardEmptyPrompt(): Locator {
    return this.page.getByTestId('schedule-board-empty')
  }

  /** The Gantt's "Not yet scheduled" side rail. */
  get unscheduledRail(): Locator {
    return this.page.getByTestId('schedule-unscheduled')
  }

  /** The open match tooltip (radix portals it to the body). */
  get matchTooltip(): Locator {
    return this.page.getByRole('tooltip')
  }

  // ----- the placement editor & its consequence confirm (ADR "the schedule is
  // solved; the call is pinned": while live, placing IS calling) --------------

  /** One list row's **Place** / **Move** trigger — the owner's, per fixture. */
  placeTrigger(fixtureId: string): Locator {
    return this.page.getByTestId(`place-trigger-${fixtureId}`)
  }

  /** The open placement editor's time input / Save / Clear, per fixture. */
  placeTime(fixtureId: string): Locator {
    return this.page.getByTestId(`place-time-${fixtureId}`)
  }

  placeSave(fixtureId: string): Locator {
    return this.page.getByTestId(`place-save-${fixtureId}`)
  }

  placeClear(fixtureId: string): Locator {
    return this.page.getByTestId(`place-clear-${fixtureId}`)
  }

  /** The consequence-stating confirm a NOTIFYING placement is gated by, and its
   * two buttons — the confirm names the consequence (`Call the match` / `Move
   * and notify` / `Cancel the call`), never a bare "OK". */
  get callDialog(): Locator {
    return this.page.getByTestId('confirm-call-dialog')
  }

  get callDialogConfirm(): Locator {
    return this.page.getByTestId('confirm-call-confirm')
  }

  get callDialogCancel(): Locator {
    return this.page.getByTestId('confirm-call-cancel')
  }

  /** One list row's called-at badge, by fixture. */
  calledBadge(fixtureId: string): Locator {
    return this.page.getByTestId(`schedule-called-${fixtureId}`)
  }
}
