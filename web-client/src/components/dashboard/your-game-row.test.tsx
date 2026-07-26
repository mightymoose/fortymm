import {
  awaitingImportDashboardRating,
  dashboardRating,
  notRatedLeagueDashboardRating,
  unratedDashboardRating,
} from '@/test/factories'

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

  // The four `state` arms — the client says the true thing per state instead of
  // the old one-string-fits-all "Not in a rated league yet." (ADR 20260725).
  it('shows the UNRATED line for a glicko2 player with no rated match yet', async () => {
    yourGameRowPage.render({ rating: unratedDashboardRating() })

    await yourGameRowPage.findHeading()
    expect(
      yourGameRowPage.emptyCard.getBody(
        'Unrated — finish a rated match to start your rating',
      ),
    ).toBeInTheDocument()
    // Crucially NOT the "not in a rated league" lie — this player IS in one.
    expect(
      yourGameRowPage.emptyCard.queryBody('Not in a rated league yet.'),
    ).toBeNull()
    // The full rating card is gone — its Peak tile confirms we didn't render it.
    expect(yourGameRowPage.ratingCard.queryStatLabel('Peak')).toBeNull()
  })

  it('shows the AWAITING_IMPORT line for a manual league pending its import', async () => {
    yourGameRowPage.render({ rating: awaitingImportDashboardRating() })

    await yourGameRowPage.findHeading()
    expect(
      yourGameRowPage.emptyCard.getBody(
        "Ratings haven't been imported for this league yet",
      ),
    ).toBeInTheDocument()
    expect(yourGameRowPage.ratingCard.queryStatLabel('Peak')).toBeNull()
  })

  it('shows the NOT_RATED_LEAGUE line only when the player is in no rated league', async () => {
    yourGameRowPage.render({ rating: notRatedLeagueDashboardRating() })

    await yourGameRowPage.findHeading()
    expect(
      yourGameRowPage.emptyCard.getBody('Not in a rated league yet.'),
    ).toBeInTheDocument()
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
