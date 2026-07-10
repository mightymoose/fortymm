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
  /** The skeleton's `<table>` — it mirrors the loaded card's table so column
   * widths derive from the same layout. Queried by test id because the
   * decorative inner tree is `aria-hidden`, so `getByRole('table')` can't
   * reach it. */
  getTable() {
    return container.getByTestId('dashboard-recent-results-skeleton')
  },
  /** Every placeholder `<tbody>` row (excludes the header row). */
  getRows() {
    return container.queryAllByTestId('dashboard-recent-results-skeleton-row')
  },
  /** Each row's collapsing opponent cell (`maxWidth:0; width:100%`) — the test
   * reads the win/loss dot placeholder from within each of these. */
  getOpponentCells() {
    return container.queryAllByTestId('dashboard-recent-results-skeleton-opponent')
  },
  // Expose the shimmer-bar queries so owners (YourGameRow) can read them.
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
