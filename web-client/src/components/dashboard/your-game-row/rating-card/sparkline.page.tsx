import { render, screen, type Container } from '@/test/utilities'

import { Sparkline, type SparklineProps } from './sparkline'
import { buildSparklineProps } from './sparkline.factory'

const scoped = (container: Container) => ({
  /** The decorative trend svg's wrapper. The svg is aria-hidden with no role
   * or name, so a testid is the only handle. */
  getSparkline() {
    return container.getByTestId('dashboard-sparkline')
  },
  querySparkline() {
    return container.queryByTestId('dashboard-sparkline')
  },
  /** The stroked trend-line path — the one with a `stroke`. The other path is
   * the gradient area fill (`fill=url(...)`, no stroke). */
  getTrendLine() {
    return container
      .getByTestId('dashboard-sparkline')
      .querySelector('path[stroke]')!
  },
  /** The gradient area-fill path — the unstroked one, closed down from the
   * trend line to the baseline. The counterpart to `getTrendLine()`. */
  getAreaFill() {
    return container
      .getByTestId('dashboard-sparkline')
      .querySelector('path:not([stroke])')!
  },
})

/**
 * Test page-object for `Sparkline` — the decorative rating-trend line on the
 * dashboard rating card. The svg is aria-hidden, so accessors resolve it by
 * testid; owners (the rating card) spread `within` to expose the same queries.
 */
export const sparklinePage = {
  render(overrides: Partial<SparklineProps> = {}) {
    const props = buildSparklineProps(overrides)
    render(<Sparkline {...props} />)
  },

  /**
   * Scope the accessors to a container — the whole `screen` (default) or a
   * `within(node)` subtree. Page objects that embed this component spread
   * this to expose the same queries as their own, rather than re-deriving.
   */
  within(container: Container = screen) {
    return scoped(container)
  },

  ...scoped(screen),
}
