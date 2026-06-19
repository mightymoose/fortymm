import type { MonoProps } from './mono'

/** Props for `Mono` — a four-digit rating, its most common usage. */
export function buildMonoProps(overrides: Partial<MonoProps> = {}): MonoProps {
  return { children: '1492', ...overrides }
}
