import { TooltipProvider } from '@/components/ui/tooltip'

import { PX_PER_MIN, type TimelineBoard } from '../../data/timeline'
import { TimelineAxis } from './timeline-axis'
import { TimelineBar } from './timeline-bar'
import { UnscheduledRail } from './unscheduled-rail'

export interface GanttBoardProps {
  /** The derived board (`buildTimelineBoard`). The owner routes to `BoardEmpty`
   * while `hasBars` is false, so this always has something to draw. */
  board: TimelineBoard
}

const LABEL_CELL =
  'sticky left-0 z-10 w-28 shrink-0 border-r border-[color:var(--border-subtle)] bg-[color:var(--bg-card)] px-3'

/**
 * The **Gantt view**: one row per tournament table (a bar-less table is a fact
 * about the day, so it keeps its row), bars at each placement's predicted time ×
 * its estimated duration, and the fixtures with no drawable position in the
 * side rail.
 *
 * The chart scrolls horizontally **inside its own container** — a labelled
 * `region` with `tabIndex=0`, so a keyboard user can reach and scroll it
 * (the #1035 family; page-level horizontal scroll is the defect, this is the
 * design). Every bar is itself a focusable button, so the content is reachable
 * without a pointer too.
 */
export const GanttBoard = ({ board }: GanttBoardProps) => {
  const trackWidth = (board.endMin - board.startMin) * PX_PER_MIN
  return (
    <div
      data-testid="schedule-gantt"
      className="flex flex-col gap-6 lg:flex-row lg:items-start"
    >
      <TooltipProvider>
        <div
          role="region"
          aria-label="Schedule by table"
          tabIndex={0}
          className="min-w-0 flex-1 overflow-x-auto rounded-[10px] border border-[color:var(--border-subtle)] bg-[color:var(--bg-card)] focus-visible:ring-2 focus-visible:ring-[color:var(--ball-500)] focus-visible:outline-none"
        >
          <div className="w-max min-w-full">
            <div className="flex">
              <div
                className={`${LABEL_CELL} self-stretch content-end pb-1 text-[10px] font-semibold tracking-[0.12em] text-[color:var(--fg-3)] uppercase`}
              >
                Table
              </div>
              <TimelineAxis startMin={board.startMin} endMin={board.endMin} />
            </div>
            {board.tables.map((row) => (
              <div
                key={row.tableId}
                data-testid={`gantt-row-${row.tableId}`}
                className="flex border-t border-[color:var(--border-subtle)] first:border-t-0"
              >
                <div className={`${LABEL_CELL} py-2 text-[12px]`}>
                  <span className="text-[color:var(--fg-1)]">{row.label}</span>
                  {/* A placement can outlive its table (ADR-0790): the row is
                      shown under its raw id, flagged, never dropped. */}
                  {!row.known && (
                    <span className="block text-[10px] text-[color:var(--warn)]">
                      Removed from the catalogue
                    </span>
                  )}
                </div>
                <div className="relative h-11" style={{ width: trackWidth }}>
                  {row.bars.map((bar) => (
                    <TimelineBar
                      key={bar.fixtureId}
                      bar={bar}
                      title={bar.label}
                      originMin={board.startMin}
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      </TooltipProvider>
      <UnscheduledRail items={board.unscheduled} />
    </div>
  )
}
