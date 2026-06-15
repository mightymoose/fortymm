import {
  buildYourGameRowView,
} from './your-game-row.factory'
import { buildRatingCardView } from './your-game-row/rating-card.factory'
import { buildRecentResultsCardView } from './your-game-row/recent-results-card.factory'
import { yourGameRowPage as page } from './your-game-row.page'

describe('YourGameRow', () => {
  it('renders the header, subtitle, and full-history link scoped to the user', async () => {
    page.render({
      view: buildYourGameRowView({
        subtitle: 'Glicko-2 · last 30 days',
        viewAllSearch: { q: 'rita.kovac' },
      }),
    })

    await page.findHeading()
    expect(page.getSubtitle('Glicko-2 · last 30 days')).toBeInTheDocument()
    expect(page.getFullHistoryLink()).toHaveAttribute(
      'href',
      '/matches?q=rita.kovac',
    )
  })

  it('wires the rating and recent cards from the view', async () => {
    page.render({
      view: buildYourGameRowView({
        rating: buildRatingCardView({ current: 1612 }),
        recent: buildRecentResultsCardView({ record: '4-1', count: 5 }),
      }),
    })

    await page.findHeading()
    // Wiring only: card internals are pinned by the rating-card and
    // recent-results-card tests.
    expect(page.rating().getHeroRating('1612')).toBeInTheDocument()
    expect(page.recent().getHeader()).toBeInTheDocument()
    expect(page.queryRatingEmpty()).not.toBeInTheDocument()
  })

  it('shows both loading placeholders while loading', async () => {
    page.render({ isLoading: true })

    await page.findHeading()
    expect(page.queryRatingSkeleton()).toBeInTheDocument()
    expect(page.queryRecentSkeleton()).toBeInTheDocument()
  })

  it('shows the rating empty state when the user has no rated league', async () => {
    page.render({ view: buildYourGameRowView({ rating: null }) })

    await page.findHeading()
    expect(page.queryRatingEmpty()).toBeInTheDocument()
  })
})
