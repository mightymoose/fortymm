import { interactiveElementsIn } from '@/test/read-only'
import { fireEvent, render, screen, within, type Container } from '@/test/utilities'

import { ScheduleTab, type ScheduleTabProps } from './schedule-tab'
import { buildScheduleTabProps } from './schedule-tab.factory'
import { boardEmptyPage } from './schedule-tab/board-empty.page'
import { ganttBoardPage } from './schedule-tab/gantt-board.page'
import { playerTimelineBoardPage } from './schedule-tab/player-timeline-board.page'
import { tierLegendPage } from './schedule-tab/tier-legend.page'

/** The tab's view toggle labels, as the user reads them. */
export type ScheduleViewLabel = 'List' | 'Gantt' | 'Player timeline'

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
  /** The sweep, minus the tab's own **view navigation** — the toggle's items, the
   * boards' focusable scroll regions and their tooltip-bearing bars, which are
   * reading affordances a viewer legitimately keeps (the Events tab's "View"
   * open-target precedent). What must be zero for a non-owner is everything
   * else: the placement editors, Run scheduler — the controls that *change*
   * something. */
  getEditingControls() {
    return interactiveElementsIn(container.getByTestId('schedule-tab')).filter(
      (el) =>
        el.closest(
          '[data-testid="schedule-view-toggle"], [data-testid="schedule-gantt"], [data-testid="schedule-player-timeline"]',
        ) === null,
    )
  },

  /** The view toggle (List | Gantt | Player timeline) — absent while there is
   * nothing to schedule at all. */
  getViewToggle() {
    return container.getByTestId('schedule-view-toggle')
  },
  queryViewToggle() {
    return container.queryByTestId('schedule-view-toggle')
  },
  /** Switch the schedule view. The toggle is a radix single ToggleGroup, so the
   * items are radios, addressed by the label the user reads. */
  setView(label: ScheduleViewLabel) {
    fireEvent.click(
      within(container.getByTestId('schedule-view-toggle')).getByRole('radio', {
        name: label,
      }),
    )
  },

  /** The board quartets' own accessors, as named sub-objects (their generic
   * `getBoard`/`getRow` names would collide if spread flat). */
  gantt: ganttBoardPage.within(container),
  players: playerTimelineBoardPage.within(container),
  boardEmpty: boardEmptyPage.within(container),
  legend: tierLegendPage.within(container),

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
