import { Locator, Page } from '@playwright/test'

import { SchedulePreviewPage } from './schedule-preview.page'

/**
 * The tournament detail page's **Schedule tab** (ADR "the schedule is solved;
 * the call is pinned") — the solve strip with the solver's latest verdict, and
 * the board's three readings of one schedule (list / Gantt / player timeline).
 *
 * Composed by `TournamentDetailPage.openSchedule()`, the child-composition
 * variant `dashboard.page.ts` established. Raw selectors stay here; specs read
 * intent-named locators. The tab **polls while the tournament is live**, so
 * every locator is safe to await with a generous timeout — the page converges
 * on the server's state without a reload.
 */
export class ScheduleTabPage {
  constructor(private readonly page: Page) {}

  /** The "Nothing to schedule yet" empty state — shown while no draw is cut, i.e.
   * the pre-live schedule with no real placements. A preview persists nothing, so
   * this stays put after previewing (the "nothing persisted" observable). */
  get emptyState(): Locator {
    return this.page.getByText('Nothing to schedule yet')
  }

  // ----- the Preview schedule modal (pre-live, owner-only) --------------------

  /** The owner's **Preview schedule** trigger — present only pre-live for the
   * owner (ADR "a schedule preview is … owner-gated … refused on live/archived"). */
  get previewTrigger(): Locator {
    return this.page.getByTestId('preview-schedule-trigger')
  }

  /** Open the Preview schedule modal and return its page object (the
   * child-composition variant, like `TournamentDetailPage.openSchedule()`). */
  async openPreview(): Promise<SchedulePreviewPage> {
    await this.previewTrigger.click()
    return new SchedulePreviewPage(this.page)
  }

  // ----- the solve strip ------------------------------------------------------

  /** The strip's `succeeded` state — the solver ran and its plan was applied.
   * Its text carries the verdict vocabulary (`VERDICT_LABEL`): "Best possible
   * plan" (OPTIMAL) or "Good plan, found under the time cap" (FEASIBLE). */
  get solveSucceeded(): Locator {
    return this.page.getByTestId('solve-strip-succeeded')
  }

  /** The designed "the day doesn't fit" state — asserted *absent* by specs that
   * seeded a day that must fit. */
  get solveInfeasible(): Locator {
    return this.page.getByTestId('solve-strip-infeasible')
  }

  // ----- the list view (the default) -------------------------------------------

  /** One table's column section, by catalogue table id — a fixture row inside
   * it IS the placement fact "this match is on that table". */
  tableSection(tableId: string): Locator {
    return this.page.getByTestId(`schedule-table-${tableId}`)
  }

  /** One match's row, by fixture id (anywhere on the board). */
  matchRow(fixtureId: string): Locator {
    return this.page.getByTestId(`schedule-match-${fixtureId}`)
  }

  /** Every match row on the board, table columns and awaiting group alike. */
  get matchRows(): Locator {
    return this.page.locator('[data-testid^="schedule-match-"]')
  }

  /** A match row scoped INSIDE its table column — visible = placed there. */
  placedRow(tableId: string, fixtureId: string): Locator {
    return this.tableSection(tableId).getByTestId(`schedule-match-${fixtureId}`)
  }

  /** The "Awaiting placement" group — hidden once every fixture is placed,
   * which is exactly what a succeeded whole-day solve guarantees. */
  get awaitingSection(): Locator {
    return this.page.getByTestId('schedule-awaiting')
  }

  /** A fixture row's match-status label ("Unplayed" → "Completed"). */
  matchStatus(fixtureId: string): Locator {
    return this.page.getByTestId(`schedule-status-${fixtureId}`)
  }

  // ----- the Gantt view ---------------------------------------------------------

  /** The view toggle's Gantt option (`ToggleGroupItem` renders `role="radio"`). */
  get ganttToggle(): Locator {
    return this.page
      .getByTestId('schedule-view-toggle')
      .getByRole('radio', { name: 'Gantt' })
  }

  /** The list option, to switch back after a board assertion. */
  get listToggle(): Locator {
    return this.page
      .getByTestId('schedule-view-toggle')
      .getByRole('radio', { name: 'List' })
  }

  /** One fixture's bar on a board track. Carries `data-tier`
   * (estimate/called/started) and an accessible name with table + times. */
  timelineBar(fixtureId: string): Locator {
    return this.page.getByTestId(`timeline-bar-${fixtureId}`)
  }
}
