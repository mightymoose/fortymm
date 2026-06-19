import type { ShimmerProps } from './shimmer'

/** Props for `Shimmer` — a 12px-tall, full-width bar, the default leaf block. */
export function buildShimmerProps(
  overrides: Partial<ShimmerProps> = {},
): ShimmerProps {
  return { height: 12, ...overrides }
}
