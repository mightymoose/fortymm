import type { TimeCellProps, TimeCellView } from './time-cell'

/** A same-day match started at 14:32. */
export function buildTimeCellView(
  overrides: Partial<TimeCellView> = {},
): TimeCellView {
  return {
    when: '14:32',
    ...overrides,
  }
}

/** Props for `TimeCell` — a same-day match started at 14:32. */
export function buildTimeCellProps(
  overrides: Partial<TimeCellProps> = {},
): TimeCellProps {
  return {
    time: buildTimeCellView(),
    ...overrides,
  }
}
