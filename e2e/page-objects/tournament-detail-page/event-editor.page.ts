import { expect, Locator, Page } from '@playwright/test'

/**
 * The **event editor** — the slide-in sheet the Events tab opens for "New event" and
 * for any event card. Scoped to what the rr-then-ko spec authors through it: the name,
 * the draw type, its qualifier count, and the pools the draw will be dealt across.
 *
 * ## Why a spec drives this sheet rather than seeding the event over the API
 *
 * The event's draw configuration is a **pair** — `draw_type` and `qualifiers_per_pool`
 * — and the client builds it in exactly one place (`drawSettingsToApi`, shared by the
 * create POST and the update PATCH). That builder is the seam the arc's 422 lived in:
 * an event whose type says `rr-then-ko` and whose body carries no qualifier count is
 * refused at the request boundary, and no mocked suite can observe it, because the mock
 * accepts whatever it is sent. Seeding the event with hand-written JSON would move the
 * payload-building out of the client and prove only that the server accepts a body the
 * test itself composed. So the sheet is driven for real.
 *
 * Raw selectors stay here; the spec reads intent-named locators (`e2e/CLAUDE.md`).
 */
export class EventEditorPage {
  constructor(private readonly page: Page) {}

  // ----- Basics -------------------------------------------------------------

  /** The event's name box. Labelled, so this is the label a director reads. */
  get nameInput(): Locator {
    return this.page.getByLabel('Event name')
  }

  /** The draw-type picker. A shadcn/Radix `Select`, so its trigger is a `combobox`
   * and its options live in a portal — hence the two-step `chooseDrawType` below. */
  get drawTypeSelect(): Locator {
    return this.page.getByRole('combobox', { name: 'Draw type' })
  }

  /** **K** — the per-pool qualifier count. Present for `rr-then-ko` and for nothing
   * else: the control is ABSENT, not disabled, for a draw type with no knockout stage
   * to qualify for, so its visibility is itself the assertion that the picker's choice
   * reached the form. */
  get qualifiersInput(): Locator {
    return this.page.getByLabel('Qualifiers per pool')
  }

  /** **R** — the round count a `swiss` event plays. Present for `swiss` and for nothing
   * else, exactly as `qualifiersInput` is present only for `rr-then-ko`: a round count is
   * a question the other three formats do not ask, and the server's draw-settings union
   * says the same by refusing the key on their arms.
   *
   * Matched by a `^Rounds` regex rather than an exact label, because the row is `required`
   * and the `Field` renders its asterisk into the accessible name. */
  get roundsInput(): Locator {
    return this.page.getByLabel(/^Rounds/)
  }

  /** The refusal the sheet shows when a save is rejected — the surface a 422 from the
   * server lands on. A spec asserts it is HIDDEN after a successful create: a create
   * that failed leaves the sheet open with this alert in it, and "the sheet is still
   * there" is a far more legible failure than a missing event three steps later. */
  get errorAlert(): Locator {
    return this.page.getByTestId('event-editor-error')
  }

  /** Pick a draw type by the label the **server's catalogue** gives it (ADR 20260726 —
   * the picker renders the served list, so this is the server's own copy, not the
   * client's). Exact, because `Round-robin` is a prefix of `Round-robin then knockout`
   * and a substring match would silently choose the wrong format. */
  async chooseDrawType(label: string): Promise<void> {
    await this.drawTypeSelect.click()
    await this.page.getByRole('option', { name: label, exact: true }).click()
    // The trigger shows the chosen label — the select actually committed, rather than
    // the click having landed on a portal that was still animating in.
    await expect(this.drawTypeSelect).toContainText(label)
  }

  /** Type the qualifier count. A blank box is a *missing answer* for this draw type
   * (never `0`), so it is filled with a real number and read back. */
  async setQualifiersPerPool(count: number): Promise<void> {
    await this.qualifiersInput.fill(String(count))
    await expect(this.qualifiersInput).toHaveValue(String(count))
  }

  /** Type the round count. A blank box is a *missing answer* for this draw type (never
   * `0`, which would be a swiss that plays nothing), so it is filled with a real number
   * and read back — the same shape `setQualifiersPerPool` takes. */
  async setRounds(rounds: number): Promise<void> {
    await this.roundsInput.fill(String(rounds))
    await expect(this.roundsInput).toHaveValue(String(rounds))
  }

  // ----- Table pools --------------------------------------------------------

  /** The "Table pools" tab of the sheet — plain component state, no navigation. */
  get poolsTab(): Locator {
    return this.page.getByRole('tab', { name: 'Table pools' })
  }

  /** Every pool card currently in the draft, so a spec can count them. */
  get poolCards(): Locator {
    return this.page.getByTestId('pool-card')
  }

  /**
   * Add `count` pools, minting each with the section's own defaults (`Pool A`, `Pool B`,
   * … over the event's window). The first one comes from the empty state's "Add first
   * pool" and the rest from the header's "Add pool" — two different controls for the
   * same act, which is a distinction the section makes and a caller should not have to.
   *
   * Leaves the pools with **no tables reserved**: `table_ids` may be empty on the wire,
   * and the draw does not need a table to be *cut* (placement is the scheduler's job).
   */
  async addPools(count: number): Promise<void> {
    await this.poolsTab.click()
    await this.page.getByRole('button', { name: 'Add first pool' }).click()
    for (let i = 1; i < count; i += 1) {
      await this.page.getByRole('button', { name: 'Add pool' }).click()
    }
    // The draft really holds `count` pools before anything is submitted — otherwise a
    // missed click surfaces as a wrong pool count in the *draw*, three steps away.
    await expect(this.poolCards).toHaveCount(count)
  }

  // ----- footer -------------------------------------------------------------

  /** The create/save button. Reads "Create event" for a new event and "Save changes"
   * for an existing one — the same button, so a spec names the act it is performing. */
  get createEventButton(): Locator {
    return this.page.getByRole('button', { name: 'Create event' })
  }
}
