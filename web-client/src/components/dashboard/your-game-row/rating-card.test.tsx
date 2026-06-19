import { dashboardRating } from '@/test/factories'

import { ratingCardPage } from './rating-card.page'

describe('RatingCard', () => {
  it('renders the current rating rounded for display', () => {
    ratingCardPage.render({ rating: dashboardRating({ current: 1611.6 }) })

    expect(ratingCardPage.getCurrentRating(1612)).toBeInTheDocument()
  })

  it('shows a positive delta as a win-toned "last match" pill', () => {
    ratingCardPage.render({ rating: dashboardRating({ delta: 24 }) })

    expect(ratingCardPage.getDeltaPill('+24 last match')).toBeInTheDocument()
  })

  it('shows a negative delta with its sign', () => {
    ratingCardPage.render({ rating: dashboardRating({ delta: -12 }) })

    expect(ratingCardPage.getDeltaPill('-12 last match')).toBeInTheDocument()
  })

  it('renders the streak pill when on a streak', () => {
    ratingCardPage.render({
      rating: dashboardRating({ streak: { kind: 'W', n: 3 } }),
    })

    expect(ratingCardPage.queryStreak('W3')).toBeInTheDocument()
  })

  it('omits the streak pill when there is no streak', () => {
    ratingCardPage.render({ rating: dashboardRating({ streak: null }) })

    expect(ratingCardPage.queryStreak(/^[WL]\d+$/)).toBeNull()
  })

  it('shows the percentile and league when ranked', () => {
    ratingCardPage.render({
      rating: dashboardRating({ percentile: 78, league_name: 'FortyMM' }),
    })

    expect(ratingCardPage.queryPercentile('78%')).toBeInTheDocument()
    expect(ratingCardPage.queryPercentile(/FortyMM/)).toBeInTheDocument()
  })

  it('shows just the league name when there is no percentile', () => {
    ratingCardPage.render({
      rating: dashboardRating({ percentile: null, league_name: 'FortyMM' }),
    })

    expect(ratingCardPage.queryPercentile('78%')).toBeNull()
    expect(ratingCardPage.queryPercentile('FortyMM')).toBeInTheDocument()
  })

  it('leads the stat tiles with the rounded peak', () => {
    ratingCardPage.render({
      rating: dashboardRating({ peak: 1620.4, stats: [] }),
    })

    expect(ratingCardPage.queryStatLabel('Peak')).toBeInTheDocument()
    // The peak value is rounded for the tile.
    expect(ratingCardPage.queryText('1620')).toBeInTheDocument()
  })

  it('caps the tile grid at three — Peak plus the first two strategy stats', () => {
    ratingCardPage.render({
      rating: dashboardRating({
        stats: [
          { label: 'RD', value: '142' },
          { label: 'Volatility', value: '0.054' },
          { label: 'Games', value: '90' },
        ],
      }),
    })

    expect(ratingCardPage.queryStatLabel('Peak')).toBeInTheDocument()
    expect(ratingCardPage.queryStatLabel('RD')).toBeInTheDocument()
    // Third strategy stat is dropped — the grid only holds three tiles.
    expect(ratingCardPage.queryStatLabel('Games')).toBeNull()
  })

  it('wires the trend sparkline in', () => {
    ratingCardPage.render()

    expect(ratingCardPage.querySparkline()).not.toBeNull()
  })
})
