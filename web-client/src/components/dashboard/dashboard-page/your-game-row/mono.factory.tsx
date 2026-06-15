import type { MonoProps } from './mono'

/** A default mono run rendering a four-digit rating. */
export function buildMonoProps(overrides: Partial<MonoProps> = {}): MonoProps {
  return { children: '1612', ...overrides }
}
