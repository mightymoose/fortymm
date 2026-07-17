import { TooltipProvider } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

import { PX_PER_MIN } from '../../data/timeline'
import { TimelineAxis } from './timeline-axis'

/** One track of the board: a sticky label cell on the left, positioned bars on
 * the shared time axis to its right. What differs per board (a table's dangling
 * flag, a player's truncated name, which title each bar carries) rides in as
 * rendered content — the shell owns only the layout the two boards share. */
export interface TimelineBoardShellRow {
  key: string
  testId: string
  /** The sticky label cell's content. */
  label: React.ReactNode
  /** The row's positioned `TimelineBar`s. */
  bars: React.ReactNode
}

export interface TimelineBoardShellProps {
  /** The scroll region's accessible name (`Schedule by table` / `… by player`). */
  regionLabel: string
  /** The label column's uppercase header (`Table` / `Player`). */
  headerLabel: string
  /** The label column's width — the one class the two boards size differently. */
  labelWidthClass: string
  /** Extra classes on the scroll region (the Gantt flexes beside its rail). */
  className?: string
  /** Extra classes on each row's label cell (the player board centers its). */
  rowLabelClassName?: string
  /** The board window (`buildTimelineBoard`) — the axis and every track width
   * derive from it. */
  startMin: number
  endMin: number
  rows: TimelineBoardShellRow[]
}

const LABEL_CELL =
  'sticky left-0 z-10 shrink-0 border-r border-[color:var(--border-subtle)] bg-[color:var(--bg-card)] px-3'

/**
 * The schedule boards' shared **shell**: the horizontally-scrolling region, the
 * header + time-axis row, and the sticky-label track rows — one layout for the
 * Gantt (tables × time) and the player timeline (entrants × time), so the two
 * boards cannot drift apart on the scrolling/keyboard contract.
 *
 * The region is a labelled `region` with `tabIndex=0`, so a keyboard user can
 * reach and scroll it (the #1035 family; page-level horizontal scroll is the
 * defect, this is the design). The bars inside are themselves focusable, so the
 * content is reachable without a pointer too.
 */
export const TimelineBoardShell = ({
  regionLabel,
  headerLabel,
  labelWidthClass,
  className,
  rowLabelClassName,
  startMin,
  endMin,
  rows,
}: TimelineBoardShellProps) => {
  const trackWidth = (endMin - startMin) * PX_PER_MIN
  return (
    <TooltipProvider>
      <div
        role="region"
        aria-label={regionLabel}
        tabIndex={0}
        className={cn(
          'overflow-x-auto rounded-[10px] border border-[color:var(--border-subtle)] bg-[color:var(--bg-card)] focus-visible:ring-2 focus-visible:ring-[color:var(--ball-500)] focus-visible:outline-none',
          className,
        )}
      >
        <div className="w-max min-w-full">
          <div className="flex">
            <div
              className={cn(
                LABEL_CELL,
                labelWidthClass,
                'self-stretch content-end pb-1 text-[10px] font-semibold tracking-[0.12em] text-[color:var(--fg-3)] uppercase',
              )}
            >
              {headerLabel}
            </div>
            <TimelineAxis startMin={startMin} endMin={endMin} />
          </div>
          {rows.map(({ key, testId, label, bars }) => (
            <div
              key={key}
              data-testid={testId}
              className="flex border-t border-[color:var(--border-subtle)] first:border-t-0"
            >
              <div
                className={cn(
                  LABEL_CELL,
                  labelWidthClass,
                  'py-2 text-[12px]',
                  rowLabelClassName,
                )}
              >
                {label}
              </div>
              <div className="relative h-11" style={{ width: trackWidth }}>
                {bars}
              </div>
            </div>
          ))}
        </div>
      </div>
    </TooltipProvider>
  )
}
