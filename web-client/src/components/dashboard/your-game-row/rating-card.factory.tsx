import { dashboardRating, establishedDashboardRating } from '@/test/factories'

import type { RatingCardProps } from './rating-card'

/**
 * Props for `RatingCard` — a climbing Glicko-2 rating on a 3-match win streak,
 * sitting in the 78th percentile with a five-point upward spark. A rich,
 * everything-on scenario so a bare render exercises the streak pill, the delta
 * chip, the percentile line, the sparkline, and the Peak + two strategy-stat
 * tiles.
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

/**
 * Props for `RatingCard` as a **brand-new player** sees it: one rated match in,
 * and that match ESTABLISHED their 1268 rather than moving it — so `delta` is
 * `null` and the card must show the number with **no chip at all**.
 *
 * This is the fixture whose absence let #952 live: every rating fixture carried
 * a signed delta, so no test could render the state in which `null >= 0`
 * (`false` in JS) painted a first-ever rating as a 232-point *loss* off a 1500
 * the player never held.
 *
 * Note what the spark is: a **single point**. `spark_data` carries rated results
 * only — never the league-join seed row — so a first-match player has exactly
 * one, which the card pads into a *flat* line. A two-point `[1500, 1268]` fixture
 * would draw the very downward slope out of nowhere that this change removes.
 */
export function buildEstablishedRatingCardProps(
  overrides: Partial<RatingCardProps> = {},
): RatingCardProps {
  return {
    rating: establishedDashboardRating({
      league_name: 'FortyMM',
      current: 1268,
      // A wide RD: the ladder has seen this player exactly once.
      stats: [
        { label: 'RD', value: '332' },
        { label: 'Volatility', value: '0.060' },
      ],
    }),
    ...overrides,
  }
}
