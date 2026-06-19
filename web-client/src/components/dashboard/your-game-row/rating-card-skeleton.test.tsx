import { ratingCardSkeletonPage } from './rating-card-skeleton.page'

describe('RatingCardSkeleton', () => {
  it('announces the load through a busy status region', () => {
    ratingCardSkeletonPage.render()

    expect(ratingCardSkeletonPage.getStatus()).toHaveAttribute(
      'aria-busy',
      'true',
    )
  })

  // No-layout-shift contract: overline (1) + big rating + delta block (3) +
  // sparkline panel (3) + three stat tiles (2 each) = 13 reserved bars.
  it('reserves the overline, rating, sparkline, and three stat tiles', () => {
    ratingCardSkeletonPage.render()

    expect(ratingCardSkeletonPage.getAllShimmers()).toHaveLength(13)
  })
})
