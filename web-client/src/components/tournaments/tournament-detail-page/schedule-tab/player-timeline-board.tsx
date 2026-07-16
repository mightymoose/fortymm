import { TooltipProvider } from '@/components/ui/tooltip'

import { PX_PER_MIN, type TimelineBoard } from '../../data/timeline'
import { TimelineAxis } from './timeline-axis'
import { TimelineBar } from './timeline-bar'

export interface PlayerTimelineBoardProps {
  /** The derived board (`buildTimelineBoard`) — same contract as `GanttBoard`:
   * the owner routes to `BoardEmpty` while `hasBars` is false. */
  board: TimelineBoard
}

const LABEL_CELL =
  'sticky left-0 z-10 w-36 shrink-0 border-r border-[color:var(--border-subtle)] bg-[color:var(--bg-card)] px-3'

/**
 * The **player-timeline view**: one row per entrant with at least one fixture,
 * their placed matches as bars over the same shared time axis — so a player's
 * day reads left to right, and the *gaps* between their bars are visible as
 * exactly that. A player whose fixtures are all unplaced keeps an honest empty
 * track (their day has no shape yet, which is information).
 *
 * Same responsive contract as the Gantt: horizontal scrolling stays inside this
 * labelled, keyboard-focusable region (#1035 family).
 */
export const PlayerTimelineBoard = ({ board }: PlayerTimelineBoardProps) => {
  const trackWidth = (board.endMin - board.startMin) * PX_PER_MIN
  return (
    <div data-testid="schedule-player-timeline">
      <TooltipProvider>
        <div
          role="region"
          aria-label="Schedule by player"
          tabIndex={0}
          className="overflow-x-auto rounded-[10px] border border-[color:var(--border-subtle)] bg-[color:var(--bg-card)] focus-visible:ring-2 focus-visible:ring-[color:var(--ball-500)] focus-visible:outline-none"
        >
          <div className="w-max min-w-full">
            <div className="flex">
              <div
                className={`${LABEL_CELL} self-stretch content-end pb-1 text-[10px] font-semibold tracking-[0.12em] text-[color:var(--fg-3)] uppercase`}
              >
                Player
              </div>
              <TimelineAxis startMin={board.startMin} endMin={board.endMin} />
            </div>
            {board.players.map((row) => (
              <div
                key={row.userId}
                data-testid={`player-row-${row.userId}`}
                className="flex border-t border-[color:var(--border-subtle)] first:border-t-0"
              >
                <div className={`${LABEL_CELL} content-center py-2 text-[12px]`}>
                  <span className="block truncate text-[color:var(--fg-1)]">
                    {row.username}
                  </span>
                </div>
                <div className="relative h-11" style={{ width: trackWidth }}>
                  {row.bars.map((bar) => (
                    <TimelineBar
                      key={bar.fixtureId}
                      bar={bar}
                      title={`vs ${bar.opponent}`}
                      originMin={board.startMin}
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      </TooltipProvider>
    </div>
  )
}
