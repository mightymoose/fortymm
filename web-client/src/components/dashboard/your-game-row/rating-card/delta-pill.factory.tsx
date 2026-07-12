import type { DeltaPillProps } from './delta-pill'

/** Props for `DeltaPill` — a modest winning move, its commonest usage.
 *
 * There is no "no delta" variant to build here, and that is the design: an
 * established rating has no delta, so it has no `DeltaPill` at all (see the
 * `delta` prop's doc). The absent-chip case is a `RatingCard` fixture —
 * `buildEstablishedRatingCardProps` — not a `DeltaPill` one. */
export function buildDeltaPillProps(
  overrides: Partial<DeltaPillProps> = {},
): DeltaPillProps {
  return { delta: 24, ...overrides }
}
