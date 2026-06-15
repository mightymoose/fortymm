import { render } from '@/test/utilities'

import { Sparkline, type SparklineProps } from './sparkline'
import { buildSparklineProps } from './sparkline.factory'

const scoped = (root: ParentNode) => ({
  /** The positioned wrapper `<div>` — fixed-width or fluid. */
  getWrapper() {
    return root.querySelector('div') as HTMLElement
  },
  /** The stroked trend line `<path>` (carries the `stroke` attribute). */
  getTrendPath() {
    return root.querySelector('svg path[stroke]') as SVGPathElement
  },
  /** The gradient-filled area `<path>` beneath the line (no `stroke`). */
  getAreaPath() {
    return Array.from(root.querySelectorAll('svg path')).find(
      (p) => !p.getAttribute('stroke'),
    ) as SVGPathElement
  },
  /** The two decorative end-point dots (a soft halo + a solid core). */
  getDots() {
    return Array.from(root.querySelectorAll('span[aria-hidden="true"]'))
  },
})

/**
 * Test page-object for `Sparkline`. The component is a pure SVG with no roles,
 * so accessors query the rendered subtree directly. `render` returns the scoped
 * accessors (bound to the render container) for the test to read.
 */
export const sparklinePage = {
  render(overrides: Partial<SparklineProps> = {}) {
    const { container } = render(<Sparkline {...buildSparklineProps(overrides)} />)
    return scoped(container)
  },

  /** Scope the accessors to a subtree so a parent page object can reuse them. */
  within(node: HTMLElement) {
    return scoped(node)
  },
}
