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

  // #952. A `null` delta means the player's last rated match ESTABLISHED this
  // rating rather than moving it — they were Unrated going in, so there is no
  // move to report. The card used to read `delta` straight; `null >= 0` is
  // `false` in JS, so a brand-new player's first-ever 1268 was announced as a
  // loss-toned "-232 last match" — 232 points off a 1500 they never held, and
  // the very same match's Δ column, on the very same page, already said "—".
  describe('when the last rated match ESTABLISHED the rating (delta: null)', () => {
    it('renders no delta chip at all', () => {
      ratingCardPage.renderEstablished()

      expect(ratingCardPage.queryDeltaPill()).toBeNull()
      // Not a "0", and certainly nothing signed and red.
      expect(ratingCardPage.queryText(/[+-]?\d+ last match/)).toBeNull()
    })

    it('still shows the rating the match established', () => {
      ratingCardPage.renderEstablished()

      expect(ratingCardPage.getCurrentRating(1268)).toBeInTheDocument()
      // The prior the league-join seeded is not a number anyone held: it must
      // not appear on the card as a rating, a peak, or a delta operand.
      expect(ratingCardPage.queryText('1500')).toBeNull()
      expect(ratingCardPage.queryText('232')).toBeNull()
      expect(ratingCardPage.queryText('-232')).toBeNull()
    })

    it('draws a FLAT sparkline — one rated result, padded, not a slope out of 1500', () => {
      ratingCardPage.renderEstablished()

      // `spark_data` is seed-free, so a first-match player has exactly one
      // point; the card pads it to two. Both ends must sit at the same height —
      // a differing y would be a trend line descending from a rating that never
      // existed.
      const d = ratingCardPage.getTrendLine().getAttribute('d') ?? ''
      const ys = [...d.matchAll(/[ML][\d.]+ ([\d.]+)/g)].map((m) => Number(m[1]))
      expect(ys).toHaveLength(2)
      expect(ys[0]).toBe(ys[1])
    })
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
