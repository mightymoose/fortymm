import type { RatingCardProps } from './rating-card'
import type {
  RatingCardStreakView,
  RatingCardView,
} from './rating-card/rating-card-view'

/** A three-win streak badge. */
export function buildRatingCardStreakView(
  overrides: Partial<RatingCardStreakView> = {},
): RatingCardStreakView {
  return { label: 'W3', isWin: true, ...overrides }
}

/**
 * A rated card: 1612 current, up +24, a W3 streak, ranked top 78% of FortyMM,
 * a rising five-point sparkline, and Peak/RD/Volatility tiles.
 */
export function buildRatingCardView(
  overrides: Partial<RatingCardView> = {},
): RatingCardView {
  return {
    current: 1612,
    delta: '+24',
    deltaIsPositive: true,
    percentile: 78,
    leagueName: 'FortyMM',
    peak: 1620,
    streak: buildRatingCardStreakView(),
    sparkPoints: [1500, 1530, 1560, 1588, 1612],
    tiles: [
      { label: 'Peak', value: '1620' },
      { label: 'RD', value: '142' },
      { label: 'Volatility', value: '0.054' },
    ],
    ...overrides,
  }
}

/** Props for `RatingCard`. */
export function buildRatingCardProps(
  overrides: Partial<RatingCardProps> = {},
): RatingCardProps {
  return { view: buildRatingCardView(), ...overrides }
}
