import { dashboardRating } from '@/test/factories'

import type { RatingCardProps } from './rating-card'

/**
 * Props for `RatingCard` — a climbing Glicko-2 rating on a 3-match win streak,
 * sitting in the 78th percentile with a five-point upward spark. A rich,
 * everything-on scenario so a bare render exercises the streak pill,
 * percentile line, sparkline, and the Peak + two strategy-stat tiles.
 */
export function buildRatingCardProps(
  overrides: Partial<RatingCardProps> = {},
): RatingCardProps {
  return {
    rating: dashboardRating({
      league_name: 'FortyMM',
      current: 1612,
      delta: 24,
      peak: 1620,
      percentile: 78,
      spark_data: [1500, 1530, 1560, 1588, 1612],
      streak: { kind: 'W', n: 3 },
      stats: [
        { label: 'RD', value: '142' },
        { label: 'Volatility', value: '0.054' },
      ],
    }),
    ...overrides,
  }
}
