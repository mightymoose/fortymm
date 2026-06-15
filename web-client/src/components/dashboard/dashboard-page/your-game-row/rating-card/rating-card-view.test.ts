import { dashboardRating } from '@/test/factories'
import {
  projectRatingCardView,
  ratingStrategyLabel,
} from './rating-card-view'

describe('projectRatingCardView', () => {
  it('rounds the hero numbers and formats the signed delta', () => {
    const view = projectRatingCardView(
      dashboardRating({ current: 1611.6, delta: 24.4, peak: 1620.2 }),
    )

    expect(view.current).toBe(1612)
    expect(view.peak).toBe(1620)
    expect(view.delta).toBe('+24')
    expect(view.deltaIsPositive).toBe(true)
  })

  it('marks a negative delta as non-positive for the loss tint', () => {
    const view = projectRatingCardView(dashboardRating({ delta: -8 }))
    expect(view.delta).toBe('-8')
    expect(view.deltaIsPositive).toBe(false)
  })

  it('projects a win streak into a tinted badge label', () => {
    const view = projectRatingCardView(
      dashboardRating({ streak: { kind: 'W', n: 3 } }),
    )
    expect(view.streak).toEqual({ label: 'W3', isWin: true })
  })

  it('projects a losing streak as a loss-tinted badge', () => {
    const view = projectRatingCardView(
      dashboardRating({ streak: { kind: 'L', n: 2 } }),
    )
    expect(view.streak).toEqual({ label: 'L2', isWin: false })
  })

  it('has no streak badge when the server reports none', () => {
    expect(projectRatingCardView(dashboardRating({ streak: null })).streak).toBeNull()
  })

  it('pads a single sparkline point to a level two-point baseline', () => {
    const view = projectRatingCardView(
      dashboardRating({ spark_data: [1500], current: 1500 }),
    )
    expect(view.sparkPoints).toEqual([1500, 1500])
  })

  it('pads an empty sparkline using the current rating', () => {
    const view = projectRatingCardView(
      dashboardRating({ spark_data: [], current: 1480 }),
    )
    expect(view.sparkPoints).toEqual([1480, 1480])
  })

  it('keeps a multi-point sparkline as-is', () => {
    const view = projectRatingCardView(
      dashboardRating({ spark_data: [1500, 1530, 1560] }),
    )
    expect(view.sparkPoints).toEqual([1500, 1530, 1560])
  })

  it('builds a Peak tile then the strategy stats, capped at three', () => {
    const view = projectRatingCardView(
      dashboardRating({
        peak: 1620,
        stats: [
          { label: 'RD', value: '142' },
          { label: 'Volatility', value: '0.054' },
          { label: 'Games', value: '40' },
        ],
      }),
    )
    expect(view.tiles).toEqual([
      { label: 'Peak', value: '1620' },
      { label: 'RD', value: '142' },
      { label: 'Volatility', value: '0.054' },
    ])
  })
})

describe('ratingStrategyLabel', () => {
  it('maps known strategy keys to friendly labels', () => {
    expect(ratingStrategyLabel('glicko2')).toBe('Glicko-2')
    expect(ratingStrategyLabel('manual')).toBe('Manual')
  })

  it('passes an unknown key through unchanged', () => {
    expect(ratingStrategyLabel('elo')).toBe('elo')
  })
})
