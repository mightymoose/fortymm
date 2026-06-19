import { render, screen, type Container } from '@/test/utilities'

import { AttentionPanelSkeleton } from './attention-panel-skeleton'
import { shimmerPage } from './shimmer.page'

const scoped = (container: Container) => ({
  /** The whole skeleton — a `role="status"` region announcing the load. */
  getStatus() {
    return container.getByRole('status', { name: /loading attention panel/i })
  },
  /** The skeleton, or null when it's been swapped for the real panel. */
  queryStatus() {
    return container.queryByRole('status', { name: /loading attention panel/i })
  },
  // Count the shimmer bars so a dropped row/heading/footer is caught.
  ...shimmerPage.within(container),
})

/**
 * Test page-object for `AttentionPanelSkeleton` — the dashboard's attention
 * loading placeholder. The component is propless, so `render` takes nothing.
 */
export const attentionPanelSkeletonPage = {
  render() {
    render(<AttentionPanelSkeleton />)
  },

  within(container: Container = screen) {
    return scoped(container)
  },

  ...scoped(screen),
}
