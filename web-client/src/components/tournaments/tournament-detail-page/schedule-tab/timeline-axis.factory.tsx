import type { TimelineAxisProps } from './timeline-axis'

/** Props for `TimelineAxis` — a short `09:00–10:30` window (half-hour ticks). */
export function buildTimelineAxisProps(
  overrides: Partial<TimelineAxisProps> = {},
): TimelineAxisProps {
  return { startMin: 540, endMin: 630, ...overrides }
}
