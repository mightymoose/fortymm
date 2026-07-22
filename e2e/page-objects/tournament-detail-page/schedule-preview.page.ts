import { Locator, Page } from '@playwright/test'

/**
 * The **Preview schedule** modal (ADR "a schedule preview is a non-persistent
 * solve over a synthetic field") — the owner-only, pre-live dialog opened from
 * the Schedule tab's `preview-schedule-trigger`. Reached through
 * `ScheduleTabPage.openPreview()`, the child-composition variant the tab objects
 * already use.
 *
 * The modal is never a blank spinner: the enqueue's *instant structure* (the
 * synthetic field line, match/bye counts, and the `Placeholder N` grid) renders
 * from the first frame, and only the **verdict** + estimated duration stream in
 * when the real solve returns from the composed stack's `preview`-queue worker.
 * Raw selectors stay here; the spec reads intent-named locators.
 */
export class SchedulePreviewPage {
  constructor(private readonly page: Page) {}

  /** The dialog itself, named by its "Preview schedule" title — its presence is
   * "the modal is open". */
  get dialog(): Locator {
    return this.page.getByRole('dialog', { name: 'Preview schedule' })
  }

  /** The live body, mounted once the enqueue 202 lands (before that, a
   * `preview-preparing` placeholder shows instead). */
  get body(): Locator {
    return this.page.getByTestId('schedule-preview')
  }

  /** The instant "Synthetic field: Open Singles 4" structure line — proof the
   * fake field rendered before any solve result. */
  get fieldSummary(): Locator {
    return this.page.getByTestId('preview-field-summary')
  }

  /** The "N matches · M byes" count line, known from the draw at enqueue time. */
  get counts(): Locator {
    return this.page.getByTestId('preview-counts')
  }

  /** The labeled wait state ("Waiting for an in-progress solve…" / "Solving
   * schedule… (Ns)") — present only while the job is queued/running. */
  get wait(): Locator {
    return this.page.getByTestId('preview-wait')
  }

  /** The streamed **verdict** — the headline that lands only when the solve
   * returns. Its text carries the verdict vocabulary ("Best possible plan" /
   * "Good plan, found under the time cap"). Its appearance IS "the preview
   * streamed to a result". */
  get verdict(): Locator {
    return this.page.getByTestId('preview-verdict')
  }

  /** The designed "doesn't fit" state — asserted absent by a spec that seeded a
   * field that must fit. */
  get infeasible(): Locator {
    return this.page.getByTestId('preview-infeasible')
  }

  /** A failed job's honest alert — asserted absent on the happy path. */
  get failed(): Locator {
    return this.page.getByTestId('preview-failed')
  }

  /** The synthetic grid — reuses the real schedule grid components, so preview
   * and reality render identically. */
  get grid(): Locator {
    return this.page.getByTestId('preview-grid')
  }

  /** Every synthetic fixture card in the grid — the reused schedule-grid rows,
   * keyed `unscheduled-<fixtureId>`. Counting these is robust to how the
   * synthetic entrant ids are formatted in the label (the count is the fact that
   * the whole fake field drew). */
  get placeholderMatches(): Locator {
    return this.grid.locator('[data-testid^="unscheduled-"]')
  }

  /** The `Placeholder N vs Placeholder M` pairing text — a preview names both
   * synthetic entrants `Placeholder <n>` (the opaque `placeholder-N` stand-ins),
   * so this proves the cards are the fake field, not real entrants. */
  get placeholderPairing(): Locator {
    return this.grid.getByText(/Placeholder \d+ vs Placeholder \d+/)
  }

  /** Close the modal with Escape — closing fires the best-effort cancel and
   * unmounts the body, returning focus to the Schedule tab. */
  async close(): Promise<void> {
    await this.page.keyboard.press('Escape')
  }
}
