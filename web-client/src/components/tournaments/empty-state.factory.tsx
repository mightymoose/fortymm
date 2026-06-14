import type { EmptyStateProps } from './empty-state'

/** Props for `EmptyState` — the "no tournaments" case. */
export function buildEmptyStateProps(
  overrides: Partial<EmptyStateProps> = {},
): EmptyStateProps {
  return { title: 'No tournaments match', ...overrides }
}
