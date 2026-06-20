import { render, screen, type Container } from '@/test/utilities'

import { Shimmer, type ShimmerProps } from './shimmer'
import { buildShimmerProps } from './shimmer.factory'

const scoped = (container: Container) => ({
  /** The shimmer bar. It's decorative (`aria-hidden`, no role), so it's
   * resolved by its `data-testid` — the only stable hook a nameless
   * placeholder can offer. */
  getShimmer() {
    return container.getByTestId('dashboard-shimmer')
  },
  /** Every shimmer bar in scope — card skeletons count these to assert they
   * reserve the right number of leaf blocks. */
  getAllShimmers() {
    return container.queryAllByTestId('dashboard-shimmer')
  },
})

/**
 * Test page-object for `Shimmer` — a single loading-placeholder bar. Owners
 * that embed shimmers spread `within` to count them as their own.
 */
export const shimmerPage = {
  render(overrides: Partial<ShimmerProps> = {}) {
    render(<Shimmer {...buildShimmerProps(overrides)} />)
  },

  within(container: Container = screen) {
    return scoped(container)
  },

  ...scoped(screen),
}
