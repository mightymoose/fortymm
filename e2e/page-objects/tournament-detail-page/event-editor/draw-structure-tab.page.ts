import { Locator, Page } from '@playwright/test'

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

  /** The number (or phrase) the row currently reads. */
  settingValue(name: string): Locator {
    return this.settingRow(name).getByTestId('draw-setting-value')
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
