import { render, screen, type Container } from '@/test/utilities'

import { shimmerPage } from '../shimmer.page'
import { RatingCardSkeleton } from './rating-card-skeleton'

const scoped = (container: Container) => ({
  /** The whole skeleton — a `role="status"` region announcing the load. */
  getStatus() {
    return container.getByRole('status', { name: /loading rating/i })
  },
  /** The skeleton, or null once the real rating card has replaced it. */
  queryStatus() {
    return container.queryByRole('status', { name: /loading rating/i })
  },
  // Count the shimmer bars so a dropped row/panel/tile is caught.
  ...shimmerPage.within(container),
})

/**
 * Test page-object for `RatingCardSkeleton` — the rating card's loading
 * placeholder. Propless, so `render` takes nothing. Owners (YourGameRow) spread
 * `within` to read the same status queries.
 */
export const ratingCardSkeletonPage = {
  render() {
    render(<RatingCardSkeleton />)
  },

  within(container: Container = screen) {
    return scoped(container)
  },

  ...scoped(screen),
}
