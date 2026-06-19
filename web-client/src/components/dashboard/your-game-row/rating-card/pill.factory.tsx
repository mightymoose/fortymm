import type { PillProps } from './pill'

/** Props for `Pill` — a default-tone "LIVE" label, its plainest usage. */
export function buildPillProps(overrides: Partial<PillProps> = {}): PillProps {
  return { children: 'LIVE', ...overrides }
}
