import { expect, Locator, Page } from '@playwright/test'

/**
 * The event editor's **Draw structure** tab (#1320) — the four structural settings of a
 * round-robin-then-knockout draw, and the live preview of the draw they add up to.
 *
 * A child page object of `EventEditorPage`, composed the way `DashboardPage.userMenu` is:
 * the tab is a surface of its own with a dozen readings on it, and folding those into the
 * editor class would grow one flat object past the point a spec can read it.
 *
 * ## Two vocabularies, deliberately
 *
 * The **settings** are addressed by the words a director reads. Each row renders a named
 * `region` (`<section aria-labelledby>` over the setting's name), so `settingValue('Pool
 * count')` asks for the row by the thing it sets rather than by its position in a list of
 * four identically-shaped rows. The **preview** is addressed by testid, because its parts
 * are one card each with no accessible name of their own.
 *
 * ## Why nothing here is a `toHaveText` of a whole card
 *
 * `textContent` inserts no whitespace between block elements, so a pool card reads
 * `Pool A8playerstop 2 advance` and the knockout card reads
 * `Knockout8-player bracketNo first-round byes112 pool matches`. A spec therefore states
 * one fact per assertion, each against a string that lives inside a single element. The
 * equation is the exception and is safe whole: its literals carry their own spaces.
 */
export class DrawStructureTabPage {
  constructor(private readonly page: Page) {}

  /** The tab's panel. Present only for an `rr-then-ko` event (ADR 20260808), so a spec
   * that asserts on this has already asserted the tab itself exists. */
  get section(): Locator {
    return this.page.getByTestId('draw-structure-section')
  }

  /** The tab's heading — `Set what matters. We’ll work out the rest.` (a right single
   * quote, `U+2019`, as the reference has it). */
  get heading(): Locator {
    return this.page.getByTestId('draw-structure-heading')
  }

  /** The field every number on the tab is derived from: the event's cap, or the
   * synthetic 16 an uncapped event is previewed against. */
  get fieldSize(): Locator {
    return this.page.getByTestId('draw-structure-field-size')
  }

  /** Where that field came from, in words — `32-player cap`, or the honest sentence for
   * an event with no cap (which is where this implementation departs from the reference
   * on purpose). */
  get previewBasis(): Locator {
    return this.page.getByTestId('draw-structure-preview-basis')
  }

  // ----- the four setting rows ----------------------------------------------

  /** One setting row, **by the setting's name** — `Pool count`, `Pool size`,
   * `Membership`, `Qualifiers per pool`. The row is a named `region`, which is the whole
   * reason a spec never needs an `nth(…)` here. */
  settingRow(name: string): Locator {
    return this.page.getByRole('region', { name, exact: true })
  }

  /** The number (or phrase) the row currently reads, **as text**.
   *
   * ⚠️ Present only while the value is the system's — a setting the director owns renders
   * a box instead, so this locator resolves nothing there and `settingInput` is what reads
   * the number. The two are never both present, which is what makes
   * `expect(settingInput(name)).toHaveCount(0)` a real statement that the setting went
   * back to being automatic. */
  settingValue(name: string): Locator {
    return this.settingRow(name).getByTestId('draw-setting-value')
  }

  /** The **manual box**, present only while the director owns this setting and may edit
   * it (there is no disabled box on this tab — ADR-0015).
   *
   * Addressed by the row's own heading, which is the box's accessible name
   * (`aria-labelledby` onto the setting's name): a box whose only label were the unit
   * after it would announce as `pools`, which is four indistinguishable boxes. Scoped to
   * the row as well, so a spec naming the wrong setting resolves nothing rather than
   * something. */
  settingInput(name: string): Locator {
    return this.settingRow(name).getByRole('textbox', { name, exact: true })
  }

  /**
   * The row's one action — the quiet text button that hands the setting over or gives it
   * back.
   *
   * **The label is an argument, not a return value**, so asking for the button is also a
   * statement about which way the row currently points: `Set myself` on a row the director
   * already owns resolves nothing, and the spec fails at the click rather than three
   * assertions later.
   *
   * Matched on the **whole** accessible name, `{label} {name}`. Three rows offer
   * `Set myself`, so the visible words alone name no setting, and the button's `aria-label`
   * says both — an `aria-label` replaces the text content for name matching, so a locator
   * asking for `Set myself` alone would resolve nothing at all.
   */
  settingAction(
    name: string,
    label: 'Set myself' | 'Use automatic' | 'Assign myself' | 'Use snake',
  ): Locator {
    return this.settingRow(name).getByRole('button', {
      name: `${label} ${name}`,
      exact: true,
    })
  }

  /** The plain words after the value — `pools`, `players per pool`. A `Membership` row
   * has none: its value is already a sentence. */
  settingUnit(name: string): Locator {
    return this.settingRow(name).getByTestId('draw-setting-unit')
  }

  /** The ownership badge — `Automatic` or `Yours`, and nothing else (ADR 20260808: the
   * owner is stated in words, never only in colour). Uppercased by CSS only, so the text
   * an assertion reads is still the capitalised word. */
  settingOwnership(name: string): Locator {
    return this.settingRow(name).getByTestId('draw-setting-ownership')
  }

  /** The one line under the badge saying where the value came from. Derived alongside
   * the number it describes, so this string and the value above it cannot fork. */
  settingSource(name: string): Locator {
    return this.settingRow(name).getByTestId('draw-setting-source')
  }

  /**
   * **Take a numeric setting and type a number into it** — the two-step act that is now
   * the only way to author one of these numbers, performed as one call for a spec that
   * wants the end state rather than the steps.
   *
   * ⚠️ **`Set myself` seeds the box from what the row was already showing**, so a caller
   * that wanted a particular number must always type it afterwards — which is what this
   * does. The seeded value is a live derivation, so it moves with the rest of the draft:
   * the qualifier count seeds at `ceil(8 / pool count)`, which is a different number
   * before and after the pools are added. **Set the pools first**, or the number typed
   * here is the only thing standing between the spec and a draw it did not ask for.
   *
   * Reads the value back for the reason `EventEditorPage.setRounds` does: a box that
   * dropped the keystroke leaves a spec asserting three screens later on a number the
   * form never held.
   */
  async setManually(name: string, value: number): Promise<void> {
    await this.settingAction(name, 'Set myself').click()
    await this.settingInput(name).fill(String(value))
    await expect(this.settingInput(name)).toHaveValue(String(value))
  }

  // ----- the one notice under the settings -----------------------------------
  //
  // At most one is on screen at a time, and which one is the derivation's choice — so a
  // spec that reads these is reading a decision, not a layout. The `Needs your call`
  // variant does not exist yet (slice 5), and nothing here reaches for it.

  /** The notice panel — the refusal (`Can’t save`) or the uneven notice (`Legal, but
   * uneven`). **Absent** when the numbers are sound, which is why every assertion that
   * a draw is fine reads `toHaveCount(0)` here rather than merely reading a green
   * verdict off the preview. */
  get issue(): Locator {
    return this.page.getByTestId('draw-issue-panel')
  }

  /** What is wrong, in the derivation's own words — `The knockout would have one
   * player`, `Pool M would have one player`, the uneven size tally.
   *
   * **This is the assertion a spec about a refusal is for.** The panel, the disabled
   * button and the `Can’t save` topline are all present for every one of the three
   * impossible competitions, so a spec that reads only those cannot tell a refusal that
   * names the real cause from the wrong-cause message #1320 was filed about. */
  get issueTitle(): Locator {
    return this.page.getByTestId('draw-issue-panel-title')
  }

  /** The line under it: what to do about the refusal, or what uneven costs. */
  get issueBody(): Locator {
    return this.page.getByTestId('draw-issue-panel-body')
  }

  /** Every offered fix's label, in the order the panel lists them — so a spec can state
   * that the refusal offers *these ways out and no others* with one
   * `toHaveText([...])`. Empty for a notice with nothing to fix. */
  get issueFixLabels(): Locator {
    return this.page.getByTestId('draw-issue-fix-label')
  }

  /** The line under one fix's label, saying what it costs or keeps. Scoped to that
   * fix's own row, because a refusal can offer two. */
  issueFixDetail(label: string): Locator {
    return this.page
      .getByTestId('draw-issue-fix')
      .filter({ has: this.page.getByText(label, { exact: true }) })
      .getByTestId('draw-issue-fix-detail')
  }

  /** Apply one, the way a director does — by the button's accessible name, which is
   * `Apply {label}`. Every visible label on these buttons reads only `Apply`, so the
   * words alone name no fix and a locator asking for `Apply` would resolve the wrong
   * row the moment a refusal offered two. */
  applyFix(label: string): Locator {
    return this.page.getByRole('button', { name: `Apply ${label}`, exact: true })
  }

  // ----- the live preview ----------------------------------------------------

  /** The sticky preview panel — `The draw as it stands`. */
  get preview(): Locator {
    return this.page.getByTestId('draw-preview')
  }

  /** The preview's verdict heading: `Ready to save`, `Your numbers disagree`, or
   * `This draw can’t work yet`. */
  get previewVerdict(): Locator {
    return this.page.getByTestId('draw-preview-verdict')
  }

  /** The badge beside it — `Sound`, `Your call`, `Impossible`. One decision with the
   * heading, so a spec reads both. */
  get previewBadge(): Locator {
    return this.page.getByTestId('draw-preview-badge')
  }

  /** The whole draw in one line: `{field} players ÷ {count} pools = {size} per pool`.
   * Safe to assert whole — every literal in it carries its own spaces. */
  get previewEquation(): Locator {
    return this.page.getByTestId('draw-preview-equation')
  }

  /** Every projected pool card, in pool order, so a spec can count them. */
  get previewPoolCards(): Locator {
    return this.page.getByTestId('draw-preview-pool-card')
  }

  /** One projected pool card, **by its letter** — `A`, `B`, … Filtered on the card's own
   * `Pool {letter}` line with `exact`, because `Pool A` is a substring of `Pool AA` and
   * the letters run past `Z` on a large field. */
  previewPoolCard(letter: string): Locator {
    return this.previewPoolCards.filter({
      has: this.page.getByText(`Pool ${letter}`, { exact: true }),
    })
  }

  /** The knockout card: the bracket size, the first-round byes, and how many matches the
   * pool stage plays to fill it. */
  get previewKnockout(): Locator {
    return this.page.getByTestId('draw-preview-knockout')
  }
}
