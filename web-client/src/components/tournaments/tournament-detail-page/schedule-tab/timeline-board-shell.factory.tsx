import type {
  TimelineBoardShellProps,
  TimelineBoardShellRow,
} from './timeline-board-shell'

/** One shell row — a labelled track with no bars (the honest empty track). */
export function buildTimelineBoardShellRow(
  overrides: Partial<TimelineBoardShellRow> = {},
): TimelineBoardShellRow {
  return {
    key: 'row-1',
    testId: 'shell-row-row-1',
    label: <span>Row 1</span>,
    bars: null,
    ...overrides,
  }
}

/** Props for `TimelineBoardShell` — a one-row board over a 09:00–10:00 window,
 * in the Gantt's own words by default. */
export function buildTimelineBoardShellProps(
  overrides: Partial<TimelineBoardShellProps> = {},
): TimelineBoardShellProps {
  return {
    regionLabel: 'Schedule by table',
    headerLabel: 'Table',
    labelWidthClass: 'w-28',
    startMin: 9 * 60,
    endMin: 10 * 60,
    rows: [buildTimelineBoardShellRow()],
    ...overrides,
  }
}
