import type { StatusBadgeProps } from './status-badge'

/** Props for `StatusBadge` — a published tournament by default. */
export function buildStatusBadgeProps(
  overrides: Partial<StatusBadgeProps> = {},
): StatusBadgeProps {
  return { status: 'published', ...overrides }
}
