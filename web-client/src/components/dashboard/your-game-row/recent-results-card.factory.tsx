import { dashboardRecentResult } from '@/test/factories'

import type { RecentResultsCardProps } from './recent-results-card'

/**
 * Props for `RecentResultsCard` — two completed matches: a 3-1 win that moved
 * the rating up, then a 1-3 loss with no rating change recorded. Exercises both
 * the win/loss score tones and the delta-vs-em-dash branch in one render.
 */
export function buildRecentResultsCardProps(
  overrides: Partial<RecentResultsCardProps> = {},
): RecentResultsCardProps {
  return {
    rows: [
      dashboardRecentResult({
        match_id: 'm-recent-1',
        opponent_username: 'silva.r',
        is_win: true,
        my_games_won: 3,
        opponent_games_won: 1,
        my_rating_change: { before: 1500, after: 1524, delta: 24 },
      }),
      dashboardRecentResult({
        match_id: 'm-recent-2',
        opponent_username: 'patel.m',
        is_win: false,
        my_games_won: 1,
        opponent_games_won: 3,
        my_rating_change: null,
      }),
    ],
    ...overrides,
  }
}
