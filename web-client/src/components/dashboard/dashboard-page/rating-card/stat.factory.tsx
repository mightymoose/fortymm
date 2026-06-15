import type { StatProps } from './stat'

/** The Peak stat tile. */
export function buildStatProps(overrides: Partial<StatProps> = {}): StatProps {
  return { label: 'Peak', value: '1620', ...overrides }
}
