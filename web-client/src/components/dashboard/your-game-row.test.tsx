import { dashboardRating } from '@/test/factories'

import { yourGameRowPage } from './your-game-row.page'

describe('YourGameRow', () => {
  it('shows skeletons in both slots while loading', async () => {
    yourGameRowPage.render({ isLoading: true })

    await yourGameRowPage.findHeading()
    expect(yourGameRowPage.ratingSkeleton.queryStatus()).not.toBeNull()
    expect(
      yourGameRowPage.recentResultsSkeleton.queryStatus(),
    ).not.toBeNull()
  })

  it('renders the rating card and recent results once loaded', async () => {
    yourGameRowPage.render({ rating: dashboardRating({ current: 1612 }) })

    await yourGameRowPage.findHeading()
    expect(yourGameRowPage.ratingCard.getCurrentRating(1612)).toBeInTheDocument()
    expect(yourGameRowPage.recentResults.queryTable()).not.toBeNull()
  })

  it('falls back to the unrated empty state when there is no rating', async () => {
    yourGameRowPage.render({ rating: null })

    await yourGameRowPage.findHeading()
    expect(
      yourGameRowPage.emptyCard.getBody('Not in a rated league yet.'),
    ).toBeInTheDocument()
    // The rating card's Peak tile is gone — we fell through to the empty state.
    expect(yourGameRowPage.ratingCard.queryStatLabel('Peak')).toBeNull()
  })

  it('labels the subtitle with the rating strategy', async () => {
    yourGameRowPage.render({ rating: dashboardRating({ strategy_key: 'glicko2' }) })

    await yourGameRowPage.findHeading()
    expect(yourGameRowPage.querySubtitle(/Glicko-2 · last 30 days/)).toBeInTheDocument()
  })

  it('points "Full history" at the matches list filtered by the current user', async () => {
    yourGameRowPage.render({ username: 'rita.kovac' })

    await yourGameRowPage.findHeading()
    expect(yourGameRowPage.getFullHistoryLink()).toHaveAttribute(
      'href',
      '/matches?q=rita.kovac',
    )
  })
})
