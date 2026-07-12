import {
  buildEstablishedRatingChange,
  buildRatingChange,
} from '@/mocks/factories/players/rating-change.factory'
import { dashboardRecentResult } from '@/test/factories'

import type { RecentResultsCardProps } from './recent-results-card'

/**
 * Props for `RecentResultsCard` — three completed matches, one per shape the Δ
 * column has to tell apart:
 *
 * 1. **moved** (silva.r): a 3-1 win that took the rating 1512 → 1536, a signed
 *    `+24`;
 * 2. **established** (invisible-sloth): the player's *first* rated match. The
 *    change is present, but its `delta` is null — there was no rating to move, it
 *    gave them one (1268). The column reads `—`, never a "−232" measured off the
 *    1500 their league-join seeded (#952);
 * 3. **no change at all** (patel.m): unrated or undecided. Also `—` — and a
 *    *different fact* from (2). A fixture carrying only one of the two nulls
 *    could not tell a collapsed implementation from a correct one.
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
        my_rating_change: buildRatingChange({ before: 1512, after: 1536 }),
      }),
      dashboardRecentResult({
        match_id: 'm-recent-established',
        opponent_username: 'invisible-sloth',
        is_win: false,
        my_games_won: 1,
        opponent_games_won: 3,
        my_rating_change: buildEstablishedRatingChange({ after: 1268 }),
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
