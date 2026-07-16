import { interactiveElementsIn } from '@/test/read-only'
import { fireEvent, render, screen, within, type Container } from '@/test/utilities'

import { ScheduleTab, type ScheduleTabProps } from './schedule-tab'
import { buildScheduleTabProps } from './schedule-tab.factory'

/** Every match row, wherever it is — the id prefix is the only thing that identifies one. */
const MATCH_TESTID = /^schedule-match-/

const rowText = (el: HTMLElement) =>
  (el.textContent ?? '').replace(/\s+/g, ' ').trim()

const scoped = (container: Container) => ({
  /** The whole tab — the scope a read-only guard sweeps. */
  getTab() {
    return container.getByTestId('schedule-tab')
  },

  /** One table's column, by table id. */
  queryTableColumn(tableId: string) {
    return container.queryByTestId(`schedule-table-${tableId}`)
  },
  getTableColumn(tableId: string) {
    return container.getByTestId(`schedule-table-${tableId}`)
  },

  /** The awaiting-placement group — the matches with no table/time yet. */
  queryAwaiting() {
    return container.queryByTestId('schedule-awaiting')
  },
  getAwaiting() {
    return container.getByTestId('schedule-awaiting')
  },

  /** The reserved pool windows shown as lightweight context. */
  queryWindows() {
    return container.queryByTestId('schedule-windows')
  },

  /** One match row, by fixture id. */
  getMatch(fixtureId: string) {
    return container.getByTestId(`schedule-match-${fixtureId}`)
  },
  queryMatch(fixtureId: string) {
    return container.queryByTestId(`schedule-match-${fixtureId}`)
  },
  /** The fixture ids of the match rows inside a scope, in DOM order. */
  matchIdsIn(scope: HTMLElement): string[] {
    return within(scope)
      .queryAllByTestId(MATCH_TESTID)
      .map((el) => el.getAttribute('data-testid')!.replace('schedule-match-', ''))
  },
  /** One match row as text — `09:00 player.1 vs player.4 · U1200 Singles Unplayed`. */
  getMatchText(fixtureId: string) {
    return rowText(container.getByTestId(`schedule-match-${fixtureId}`))
  },
  /** A match's status label (`Unplayed`, `Completed`, …). */
  getStatus(fixtureId: string) {
    return container.getByTestId(`schedule-status-${fixtureId}`)
  },

  /** The **Place** / **Move** trigger the owner sees on a match — absent for a non-owner
   * and for a finished (frozen) match. */
  queryPlaceTrigger(fixtureId: string) {
    return container.queryByTestId(`place-trigger-${fixtureId}`)
  },
  getPlaceTrigger(fixtureId: string) {
    return container.getByTestId(`place-trigger-${fixtureId}`)
  },
  /** Open the placement editor for a match (clicks its trigger). */
  openPlacement(fixtureId: string) {
    fireEvent.click(container.getByTestId(`place-trigger-${fixtureId}`))
  },
  queryPlaceEditor(fixtureId: string) {
    return container.queryByTestId(`place-editor-${fixtureId}`)
  },
  /** The predicted-start time input in an open editor. */
  getPlaceTime(fixtureId: string) {
    return container.getByTestId(`place-time-${fixtureId}`) as HTMLInputElement
  },
  setPlaceTime(fixtureId: string, value: string) {
    fireEvent.change(container.getByTestId(`place-time-${fixtureId}`), {
      target: { value },
    })
  },
  /** Save / Clear the placement in an open editor. */
  savePlacement(fixtureId: string) {
    fireEvent.click(container.getByTestId(`place-save-${fixtureId}`))
  },
  clearPlacement(fixtureId: string) {
    fireEvent.click(container.getByTestId(`place-clear-${fixtureId}`))
  },
  queryClear(fixtureId: string) {
    return container.queryByTestId(`place-clear-${fixtureId}`)
  },

  /** The solve strip (its own quartet — `solve-strip.page` has the fine-grained
   * accessors; these are the joints the TAB's tests drive). */
  getSolveStrip() {
    return container.getByTestId('solve-strip')
  },
  queryStripState(state: 'none' | 'solving' | 'succeeded' | 'infeasible' | 'failed') {
    return container.queryByTestId(`solve-strip-${state}`)
  },
  getRunScheduler() {
    return container.getByTestId('run-scheduler') as HTMLButtonElement
  },
  queryRunScheduler() {
    return container.queryByTestId('run-scheduler')
  },
  clickRunScheduler() {
    fireEvent.click(container.getByTestId('run-scheduler'))
  },
  queryRunNotice() {
    return container.queryByTestId('run-scheduler-notice')
  },

  /** EVERY interactive control in the tab — the sweep a "a non-owner is offered nothing"
   * guard needs (ADR-0015: no control at all, not a disabled one). */
  getControls() {
    return interactiveElementsIn(container.getByTestId('schedule-tab'))
  },

  within(node: Container = screen) {
    return scoped(node)
  },
})

/**
 * Test page-object for `ScheduleTab`.
 *
 * The tab owns the placement mutation (`usePlaceFixture`), so a test that saves a
 * placement stubs the endpoint itself — `mockFixturePlacementEndpoint`
 * (`@/mocks/endpoints/tournaments/tournaments.endpoint`). Rendering alone fetches
 * nothing: the schedule is derived from the tournament it is handed.
 */
export const scheduleTabPage = {
  render(overrides: Partial<ScheduleTabProps> = {}) {
    render(<ScheduleTab {...buildScheduleTabProps(overrides)} />)
  },

  ...scoped(screen),
}
