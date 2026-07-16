import { render, screen, within, type Container } from '@/test/utilities'

import { GanttBoard, type GanttBoardProps } from './gantt-board'
import { buildGanttBoardProps } from './gantt-board.factory'
import { timelineBarPage } from './timeline-bar.page'
import { timelineAxisPage } from './timeline-axis.page'
import { unscheduledRailPage } from './unscheduled-rail.page'

const scoped = (container: Container) => ({
  queryBoard() {
    return container.queryByTestId('schedule-gantt')
  },
  getBoard() {
    return container.getByTestId('schedule-gantt')
  },
  /** The horizontally-scrolling chart region — labelled and keyboard-focusable
   * (#1035 family). */
  getScrollRegion() {
    return container.getByRole('region', { name: 'Schedule by table' })
  },
  /** One table's row, by table id — present for every tournament table, bars
   * or none. */
  getRow(tableId: string) {
    return container.getByTestId(`gantt-row-${tableId}`)
  },
  queryRow(tableId: string) {
    return container.queryByTestId(`gantt-row-${tableId}`)
  },
  /** The fixture ids of one row's bars, in DOM order. */
  barIdsIn(tableId: string): string[] {
    return within(this.getRow(tableId))
      .queryAllByTestId(/^timeline-bar-/)
      .map((el) => el.getAttribute('data-testid')!.replace('timeline-bar-', ''))
  },
  // The bars' own accessors (tier, focus, tooltip) and the rail's, scoped here.
  ...timelineBarPage.within(container),
  ...timelineAxisPage.within(container),
  ...unscheduledRailPage.within(container),

  within(node: Container = screen) {
    return scoped(node)
  },
})

/**
 * Test page-object for `GanttBoard`. Pure display: rendering fetches nothing —
 * the board arrives derived (`buildScheduleBoard`). Tooltips portal to the
 * body, so use `timelineBarPage.findTooltip()` (re-exported here) after
 * focusing a bar.
 */
export const ganttBoardPage = {
  render(overrides: Partial<GanttBoardProps> = {}) {
    render(<GanttBoard {...buildGanttBoardProps(overrides)} />)
  },

  findTooltip: timelineBarPage.findTooltip,


  ...scoped(screen),
}
