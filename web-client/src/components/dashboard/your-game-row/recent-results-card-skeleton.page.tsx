import { render, screen, type Container } from '@/test/utilities'

import { shimmerPage } from '../shimmer.page'
import { RecentResultsCardSkeleton } from './recent-results-card-skeleton'

const scoped = (container: Container) => ({
  /** The whole skeleton — a `role="status"` region announcing the load. */
  getStatus() {
    return container.getByRole('status', { name: /loading recent matches/i })
  },
  /** The skeleton, or null once the real results table has replaced it. */
  queryStatus() {
    return container.queryByRole('status', { name: /loading recent matches/i })
  },
  // Count the shimmer bars so a dropped header cell or row column is caught.
  ...shimmerPage.within(container),
})

/**
 * Test page-object for `RecentResultsCardSkeleton` — the recent-results card's
 * loading placeholder. Propless, so `render` takes nothing. Owners
 * (YourGameRow) spread `within` to read the same status queries.
 */
export const recentResultsCardSkeletonPage = {
  render() {
    render(<RecentResultsCardSkeleton />)
  },

  within(container: Container = screen) {
    return scoped(container)
  },

  ...scoped(screen),
}
