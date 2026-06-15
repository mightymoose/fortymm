import { within } from '@/test/utilities'

import { buildRatingCardView } from './rating-card.factory'
import { ratingCardPage as page } from './rating-card.page'

describe('RatingCard', () => {
  it('shows the hero rating, delta badge, streak, and percentile', () => {
    page.render({
      view: buildRatingCardView({
        current: 1612,
        delta: '+24',
        deltaIsPositive: true,
        streak: { label: 'W3', isWin: true },
        percentile: 78,
        leagueName: 'FortyMM',
      }),
    })

    expect(page.getHeroRating('1612')).toBeInTheDocument()
    expect(page.getDeltaBadge()).toHaveTextContent('+24 last match')
    expect(page.queryStreakBadge('W3')).toBeInTheDocument()
    expect(page.queryPercentile('78%')).toBeInTheDocument()
    expect(page.getByText(/in FortyMM/i)).toBeInTheDocument()
  })

  it('tints the delta badge for a loss', () => {
    page.render({
      view: buildRatingCardView({ delta: '-8', deltaIsPositive: false }),
    })

    expect(page.getDeltaBadge()).toHaveClass('text-[color:var(--loss)]')
  })

  it('omits the streak badge when there is no streak', () => {
    page.render({ view: buildRatingCardView({ streak: null }) })
    expect(page.queryStreakBadge('W3')).not.toBeInTheDocument()
  })

  it('drops the "Top N%" line when the rating is unranked', () => {
    page.render({
      view: buildRatingCardView({ percentile: null, leagueName: 'FortyMM' }),
    })

    expect(page.queryPercentile('78%')).not.toBeInTheDocument()
    expect(page.getByText('FortyMM')).toBeInTheDocument()
  })

  it('renders a stat tile per view tile', () => {
    page.render({
      view: buildRatingCardView({
        tiles: [
          { label: 'Peak', value: '1620' },
          { label: 'RD', value: '142' },
        ],
      }),
    })

    expect(within(page.getStatTile('Peak')).getByText('1620')).toBeInTheDocument()
    expect(within(page.getStatTile('RD')).getByText('142')).toBeInTheDocument()
  })

  it('plots the padded sparkline series', () => {
    page.render({ view: buildRatingCardView({ sparkPoints: [1500, 1530, 1560] }) })

    const d = page.sparkline().getTrendPath().getAttribute('d') ?? ''
    // 3 points → 1 move + 2 line segments.
    expect(d.match(/L/g)).toHaveLength(2)
  })
})
