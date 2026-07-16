import type {
  TimelineBoard,
  TimelinePlayerRow,
  TimelineTableRow,
} from '../../data/timeline'
import type { GanttBoardProps } from './gantt-board'
import {
  buildTimelineBarData,
  buildTimelinePlayerBarData,
} from './timeline-bar.factory'
import { buildUnscheduledFixture } from './unscheduled-rail.factory'

/** One table row — `T1` with the default estimate bar. */
export function buildTimelineTableRow(
  overrides: Partial<TimelineTableRow> = {},
): TimelineTableRow {
  return {
    tableId: 't1',
    label: 'T1',
    known: true,
    bars: [buildTimelineBarData()],
    ...overrides,
  }
}

/** One player row — `player.1` with the default bar, facing `player.4`. */
export function buildTimelinePlayerRow(
  overrides: Partial<TimelinePlayerRow> = {},
): TimelinePlayerRow {
  return {
    userId: 'u-1',
    username: 'player.1',
    bars: [buildTimelinePlayerBarData()],
    ...overrides,
  }
}

/**
 * A **morning board with all three tiers on it**: `T1` holds an estimate
 * (`fx-a-1`, 09:00) and an in-progress match (`fx-a-3`, 11:00), `T2` holds a
 * called match (`fx-a-2`, 10:00), `T3` is honestly empty, and Pool B's fixture
 * (`fx-b-1`) waits in the rail. Window 09:00–12:30 on 2026-06-13. Both players'
 * rows mirror the same bars, so one factory feeds both boards.
 */
export function buildScheduleBoard(
  overrides: Partial<TimelineBoard> = {},
): TimelineBoard {
  const estimate = buildTimelineBarData()
  const called = buildTimelineBarData({
    fixtureId: 'fx-a-2',
    label: 'player.1 vs player.5',
    b: 'player.5',
    tableId: 't2',
    tableLabel: 'T2',
    startMin: 600,
    endMin: 635,
    startClock: '10:00',
    endClock: '10:35',
    tier: 'called',
    pinnedAt: '2026-06-13T09:50:00',
    callNotifiedCount: 1,
  })
  const started = buildTimelineBarData({
    fixtureId: 'fx-a-3',
    label: 'player.4 vs player.5',
    a: 'player.4',
    b: 'player.5',
    startMin: 660,
    endMin: 695,
    startClock: '11:00',
    endClock: '11:35',
    tier: 'started',
    status: 'in_progress',
  })
  return {
    originDate: '2026-06-13',
    startMin: 540,
    endMin: 750,
    tables: [
      buildTimelineTableRow({ bars: [estimate, started] }),
      buildTimelineTableRow({ tableId: 't2', label: 'T2', bars: [called] }),
      buildTimelineTableRow({ tableId: 't3', label: 'T3', bars: [] }),
    ],
    players: [
      buildTimelinePlayerRow({
        bars: [
          { ...estimate, opponent: 'player.4' },
          { ...called, opponent: 'player.5' },
        ],
      }),
      buildTimelinePlayerRow({
        userId: 'u-4',
        username: 'player.4',
        bars: [
          { ...estimate, opponent: 'player.1' },
          { ...started, opponent: 'player.5' },
        ],
      }),
    ],
    unscheduled: [buildUnscheduledFixture()],
    hasBars: true,
    ...overrides,
  }
}

/** Props for `GanttBoard` — the three-tier morning board above. */
export function buildGanttBoardProps(
  overrides: Partial<GanttBoardProps> = {},
): GanttBoardProps {
  return { board: buildScheduleBoard(), ...overrides }
}
