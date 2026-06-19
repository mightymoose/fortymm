import type { StatProps } from './stat'

/** Props for `Stat` — a peak-rating tile, its most common usage. */
export function buildStatProps(overrides: Partial<StatProps> = {}): StatProps {
  return { label: 'Peak', value: 1531, ...overrides }
}
