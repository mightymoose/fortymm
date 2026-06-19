import { recentResultsCardSkeletonPage } from './recent-results-card-skeleton.page'

describe('RecentResultsCardSkeleton', () => {
  it('announces the load through a busy status region', () => {
    recentResultsCardSkeletonPage.render()

    expect(recentResultsCardSkeletonPage.getStatus()).toHaveAttribute(
      'aria-busy',
      'true',
    )
  })

  // No-layout-shift contract: a two-bar header + three rows of four columns
  // plus a leading status dot (5 bars each) = 17 reserved bars.
  it('reserves the header and three four-column result rows', () => {
    recentResultsCardSkeletonPage.render()

    expect(recentResultsCardSkeletonPage.getAllShimmers()).toHaveLength(17)
  })
})
