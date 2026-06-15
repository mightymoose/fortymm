import type { SkeletonCardProps } from './skeleton-card'

/** A 260px-tall "Loading rating" placeholder. */
export function buildSkeletonCardProps(
  overrides: Partial<SkeletonCardProps> = {},
): SkeletonCardProps {
  return { label: 'Loading rating', height: 260, ...overrides }
}
