import type { PoolCardProps } from './pool-card'

/**
 * `Pool A` in the reference's **"Nothing set"** state
 * (`docs/designs/rr-then-ko-draw-structure/nothing-set.png`): eight players, two of them
 * advancing — a pool that can be played, so the bad state is something a test asks for
 * rather than something it gets by accident.
 */
export function buildPoolCardProps(
  overrides: Partial<PoolCardProps> = {},
): PoolCardProps {
  return {
    letter: 'A',
    size: 8,
    qualifiers: 2,
    ...overrides,
  }
}
