import { render, screen, type Container } from '@/test/utilities'

import {
  SchedulePreviewModal,
  type SchedulePreviewModalProps,
} from './schedule-preview-modal'
import { buildSchedulePreviewModalProps } from './schedule-preview-modal.factory'

const scoped = (container: Container) => ({
  queryDialog() {
    return container.queryByRole('dialog')
  },
  /** The synthetic-field line ("Open Singles 4") — part of the instant structure. */
  queryFieldSummary() {
    return container.queryByTestId('preview-field-summary')
  },
  findFieldSummary() {
    return container.findByTestId('preview-field-summary')
  },
  /** The "N matches · M byes" count line — instant, before the solve lands. */
  queryCounts() {
    return container.queryByTestId('preview-counts')
  },
  /** The verdict + estimated duration + peak tables — present only once `done`. */
  queryVerdict() {
    return container.queryByTestId('preview-verdict')
  },
  findVerdict() {
    return container.findByTestId('preview-verdict')
  },
  /** The labeled wait state (queued/running). */
  queryWait() {
    return container.queryByTestId('preview-wait')
  },
  findWait() {
    return container.findByTestId('preview-wait')
  },
  /** The synthetic grid (reused schedule grid components), or its skeleton. */
  queryGrid() {
    return container.queryByTestId('preview-grid')
  },
  /** One synthetic fixture card in the grid, by its fixture id. */
  queryFixture(fixtureId: string) {
    return container.queryByTestId(`unscheduled-${fixtureId}`)
  },
  /** The infeasibility-reasons panel shown INSTEAD of a grid. */
  queryInfeasible() {
    return container.queryByTestId('preview-infeasible')
  },
  findInfeasible() {
    return container.findByTestId('preview-infeasible')
  },
  /** The always-present honest-notes strip. */
  queryNotes() {
    return container.queryByTestId('preview-notes')
  },
  /** The per-event field-size override input for one event, by its display name. */
  getOverrideInput(eventName: string) {
    return container.getByLabelText(`Field size for ${eventName}`)
  },
  findOverrideInput(eventName: string) {
    return container.findByLabelText(`Field size for ${eventName}`)
  },
  getRerunButton() {
    return container.getByRole('button', { name: /Re-run/ })
  },
})

/**
 * Test page-object for `SchedulePreviewModal`. The dialog portals to the body, so
 * accessors resolve against `screen`. The instant structure appears after the
 * enqueue 202 (async) and the verdict after the polled solve resolves (async), so
 * assert those with the `find*` accessors; use the `query*` accessors to prove a
 * thing is absent at a given frame (the streaming-before-result assertion).
 */
export const schedulePreviewModalPage = {
  render(overrides: Partial<SchedulePreviewModalProps> = {}) {
    return render(
      <SchedulePreviewModal {...buildSchedulePreviewModalProps(overrides)} />,
    )
  },

  within(container: Container = screen) {
    return scoped(container)
  },

  ...scoped(screen),
}
