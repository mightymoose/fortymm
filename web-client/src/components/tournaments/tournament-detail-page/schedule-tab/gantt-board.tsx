import type { TimelineBoard } from '../../data/timeline'
import { TimelineBar } from './timeline-bar'
import { TimelineBoardShell } from './timeline-board-shell'
import { UnscheduledRail } from './unscheduled-rail'

export interface GanttBoardProps {
  /** The derived board (`buildTimelineBoard`). The owner routes to `BoardEmpty`
   * while `hasBars` is false, so this always has something to draw. */
  board: TimelineBoard
}

/**
 * The **Gantt view**: one row per tournament table (a bar-less table is a fact
 * about the day, so it keeps its row), bars at each placement's predicted time ×
 * its estimated duration, and the fixtures with no drawable position in the
 * side rail.
 *
 * The scrolling/keyboard contract (the #1035 family) lives on the shared
 * `TimelineBoardShell`; this composes the table rows — including the dangling
 * catalogue flag — and the unscheduled rail onto it.
 */
export const GanttBoard = ({ board }: GanttBoardProps) => (
  <div
    data-testid="schedule-gantt"
    className="flex flex-col gap-6 lg:flex-row lg:items-start"
  >
    <TimelineBoardShell
      regionLabel="Schedule by table"
      headerLabel="Table"
      labelWidthClass="w-28"
      className="min-w-0 flex-1"
      startMin={board.startMin}
      endMin={board.endMin}
      rows={board.tables.map((row) => ({
        key: row.tableId,
        testId: `gantt-row-${row.tableId}`,
        label: (
          <>
            <span className="text-[color:var(--fg-1)]">{row.label}</span>
            {/* A placement can outlive its table (ADR-0790): the row is
                shown under its raw id, flagged, never dropped. */}
            {!row.known && (
              <span className="block text-[10px] text-[color:var(--warn)]">
                Removed from the catalogue
              </span>
            )}
          </>
        ),
        bars: row.bars.map((bar) => (
          <TimelineBar
            key={bar.fixtureId}
            bar={bar}
            title={bar.label}
            originMin={board.startMin}
          />
        )),
      }))}
    />
    <UnscheduledRail items={board.unscheduled} />
  </div>
)
