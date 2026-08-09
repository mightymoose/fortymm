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

  /** The **refused enqueue** alert — what the modal shows *instead of* any structure
   * when the POST is rejected (422 nothing previewable, 409 not pre-live, 429, 403).
   *
   * Asserted absent by a spec whose preview must have been accepted. It is the state
   * a director used to be left in whenever one event of the tournament was a bracket
   * (#1228): the whole preview refused, no grid, no verdict, nothing about the
   * round-robin standing beside it. */
  get enqueueError(): Locator {
    return this.page.getByTestId('preview-enqueue-error')
  }

  /** The always-present **honest-notes** strip — the ADR's "say what this estimate
   * assumes" footer: the disjoint-field caveat, then a line for each event the preview
   * left out (whole, or its knockout stage), then the synthetic count assumed per
   * previewed event.
   *
   * This is where a director *reads* that an event is missing on purpose, so a spec
   * about a skipped event asserts on this text rather than on its own absence
   * elsewhere. The lines past the first arrive with the solve result, so wait for the
   * `verdict` before reading it. */
  get notes(): Locator {
    return this.page.getByTestId('preview-notes')
  }

  /** The per-event **override** row — one field-size box per event a synthetic field
   * was minted for, plus Re-run. An event the preview covers nothing of has no box
   * here, because the server sends no field summary for it. */
  get overrides(): Locator {
    return this.page.getByTestId('preview-overrides')
  }

  /** One event's field-size box, by the event's **name** — the handle a director has
   * on it (`aria-label="Field size for <event>"`). */
  overrideFor(eventName: string): Locator {
    return this.overrides.getByLabel(`Field size for ${eventName}`)
  }

  /** One event's section of the synthetic grid, by event id. Its presence is "this
   * event was previewed"; a `toHaveCount(0)` on it is "this event contributed nothing
   * to the plan on screen". */
  eventSection(eventId: string): Locator {
    return this.page.getByTestId(`preview-event-${eventId}`)
  }

  /** The synthetic fixture cards of ONE event's section — the count that says how much
   * of *that* event was laid out, as opposed to `placeholderMatches`, which counts the
   * whole tournament's grid and so cannot tell one event's matches from another's. */
  placeholderMatchesFor(eventId: string): Locator {
    return this.eventSection(eventId).locator('[data-testid^="unscheduled-"]')
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
