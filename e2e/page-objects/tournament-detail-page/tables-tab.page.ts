import { Locator, Page } from '@playwright/test'

/**
 * The tournament detail page's **Tables tab** — the venue catalogue (ADR 20260801,
 * "a placement names a real table, and only that is an invariant"), and the one
 * refusal editing it can meet.
 *
 * Composed by `TournamentDetailPage.openTables()`, the child-composition variant
 * `dashboard.page.ts` established. Raw selectors stay here; specs read intent-named
 * locators.
 *
 * The vocabulary deliberately mirrors the web-client suite's own tables-tab page
 * objects (`tables-tab.page.tsx`, and the Tables section of
 * `web-client/e2e/page-objects/tournaments/tournament-detail.page.ts`) — same nouns for
 * the same controls, so a reader moving between the three suites is reading one surface
 * described three times rather than three parallel vocabularies.
 */
export class TablesTabPage {
  constructor(private readonly page: Page) {}

  /** The tab's root. A spec awaits it before asserting on cards: every "the catalogue
   * shows X" assertion passes vacuously against a tab that has not rendered. */
  get root(): Locator {
    return this.page.getByTestId('tables-tab')
  }

  /** One table's card, by the label the director reads.
   *
   * Filtered by an **exact** text match on the label rather than `hasText`'s substring
   * match: a card also carries its court line and any using-event badges, and "Table 1"
   * is a substring of "Table 10" — so a substring filter can resolve two cards and quietly
   * turn a "the table is gone" assertion into an assertion about its neighbour. */
  tableCard(label: string): Locator {
    return this.root
      .locator('[data-slot=card]')
      .filter({ has: this.page.getByText(label, { exact: true }) })
  }

  /** One table's Remove button, by label. Owner-only — a viewer is offered none. */
  removeTableButton(label: string): Locator {
    return this.page.getByRole('button', { name: `Remove ${label}` })
  }

  // ----- the in-use refusal, asked back as a question -------------------------

  /** The confirm an in-use removal's **409** opens. Not scoped to `root`: Radix portals
   * an `AlertDialog` to the body, so a tab-scoped query finds nothing whether it opened
   * or not. */
  get removeTableConfirm(): Locator {
    return this.page.getByTestId('confirm-remove-table')
  }

  /** The confirm's body — the **server's own sentence**, verbatim. The whole reason the
   * dialog exists: it names the tables by label, counts the matches placed at them and
   * states both ways out, none of which a client can reconstruct. */
  get removeTableConfirmDetail(): Locator {
    return this.page.getByTestId('confirm-remove-table-detail')
  }

  /** "Remove and unplace" — re-sends the identical edit plus the opt-in. */
  get removeTableConfirmButton(): Locator {
    return this.page.getByTestId('confirm-remove-table-confirm')
  }

  /** "Keep the table" — cancelling sends nothing at all. */
  get removeTableCancelButton(): Locator {
    return this.page.getByTestId('confirm-remove-table-cancel')
  }

  /** The tab's inline failure banner — every failure that is NOT the in-use refusal, in
   * the client's own words. Asserted *absent* by a spec whose refusal must have been
   * classified as a question rather than reported as an error. */
  get tablesError(): Locator {
    return this.page.getByTestId('tables-error')
  }
}
