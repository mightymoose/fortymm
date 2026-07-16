import type { TimelineBoard } from '../../data/timeline'
import { TimelineBar } from './timeline-bar'
import { TimelineBoardShell } from './timeline-board-shell'

export interface PlayerTimelineBoardProps {
  /** The derived board (`buildTimelineBoard`) — same contract as `GanttBoard`:
   * the owner routes to `BoardEmpty` while `hasBars` is false. */
  board: TimelineBoard
}

/**
 * The **player-timeline view**: one row per entrant with at least one fixture,
 * their placed matches as bars over the same shared time axis — so a player's
 * day reads left to right, and the *gaps* between their bars are visible as
 * exactly that. A player whose fixtures are all unplaced keeps an honest empty
 * track (their day has no shape yet, which is information).
 *
 * Same responsive contract as the Gantt, by construction: the scrolling,
 * keyboard-focusable region is the shared `TimelineBoardShell` (#1035 family).
 */
export const PlayerTimelineBoard = ({ board }: PlayerTimelineBoardProps) => (
  <div data-testid="schedule-player-timeline">
    <TimelineBoardShell
      regionLabel="Schedule by player"
      headerLabel="Player"
      labelWidthClass="w-36"
      rowLabelClassName="content-center"
      startMin={board.startMin}
      endMin={board.endMin}
      rows={board.players.map((row) => ({
        key: row.userId,
        testId: `player-row-${row.userId}`,
        label: (
          <span className="block truncate text-[color:var(--fg-1)]">
            {row.username}
          </span>
        ),
        bars: row.bars.map((bar) => (
          <TimelineBar
            key={bar.fixtureId}
            bar={bar}
            title={`vs ${bar.opponent}`}
            originMin={board.startMin}
          />
        )),
      }))}
    />
  </div>
)
