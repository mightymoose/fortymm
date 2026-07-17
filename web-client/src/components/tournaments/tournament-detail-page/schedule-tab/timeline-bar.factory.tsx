import type { TimelineBarData, TimelinePlayerBarData } from '../../data/timeline'
import type { TimelineBarProps } from './timeline-bar'

/** One placed, **unpinned** Bo5 fixture — `player.1 vs player.4`, U1200 Singles
 * Pool A, on `T1` at `09:00` for 35 estimated minutes: the ordinary `estimate`
 * tier every solve produces. A test that wants a call passes
 * `{ tier: 'called', pinnedAt: '…', callNotifiedCount: 1 }`; a started bar
 * passes `{ tier: 'started', status: 'in_progress' }` — keep each set
 * consistent, the way the wire delivers them. */
export function buildTimelineBarData(
  overrides: Partial<TimelineBarData> = {},
): TimelineBarData {
  return {
    fixtureId: 'fx-a-1',
    eventName: 'U1200 Singles',
    poolName: 'Pool A',
    label: 'player.1 vs player.4',
    a: 'player.1',
    b: 'player.4',
    tableId: 't1',
    tableLabel: 'T1',
    date: '2026-06-13',
    startMin: 540,
    endMin: 575,
    durationMin: 35,
    startClock: '09:00',
    endClock: '09:35',
    tier: 'estimate',
    status: null,
    pinnedAt: null,
    callNotifiedCount: 0,
    ...overrides,
  }
}

/** The same bar from `player.1`'s side of the net — a player row's bar. */
export function buildTimelinePlayerBarData(
  overrides: Partial<TimelinePlayerBarData> = {},
): TimelinePlayerBarData {
  return { ...buildTimelineBarData(), opponent: 'player.4', ...overrides }
}

/** Props for `TimelineBar` — the default bar on a track whose window opens at
 * `09:00` (origin minute 540), titled with its full pairing (the Gantt's form). */
export function buildTimelineBarProps(
  overrides: Partial<TimelineBarProps> = {},
): TimelineBarProps {
  const bar = overrides.bar ?? buildTimelineBarData()
  return { bar, title: bar.label, originMin: 540, ...overrides }
}
