import type { SkeletonCardProps } from './skeleton-card'

/** Props for `SkeletonCard` — a generic loading panel. */
export function buildSkeletonCardProps(
  overrides: Partial<SkeletonCardProps> = {},
): SkeletonCardProps {
  return { label: 'Loading', height: 260, ...overrides }
}
