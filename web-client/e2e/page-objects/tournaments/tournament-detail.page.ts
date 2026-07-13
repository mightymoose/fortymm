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
}
