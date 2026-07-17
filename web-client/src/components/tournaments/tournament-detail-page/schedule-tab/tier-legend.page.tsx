import { render, screen, type Container } from '@/test/utilities'

import { TierLegend } from './tier-legend'

const scoped = (container: Container) => ({
  queryLegend() {
    return container.queryByTestId('schedule-tier-legend')
  },
  getLegend() {
    return container.getByTestId('schedule-tier-legend')
  },

  within(node: Container = screen) {
    return scoped(node)
  },
})

/** Test page-object for `TierLegend` — the boards' three-tier key. */
export const tierLegendPage = {
  render() {
    render(<TierLegend />)
  },


  ...scoped(screen),
}
