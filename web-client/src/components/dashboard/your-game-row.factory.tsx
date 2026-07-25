import { dashboardRating, dashboardRecentResult } from '@/test/factories'

import type { YourGameRowProps } from './your-game-row'

/**
 * Props for `YourGameRow` — the loaded, fully-rated case: a Glicko-2 rating and
 * a couple of recent results for the signed-in user "rita.kovac". Override
 * `isLoading` for the skeletons, or pass a non-RATED rating block
 * (`unratedDashboardRating()` etc.) to drive the per-state empty card.
 */
export function buildYourGameRowProps(
  overrides: Partial<YourGameRowProps> = {},
): YourGameRowProps {
  return {
    rating: dashboardRating({ strategy_key: 'glicko2' }),
    recent: [
      dashboardRecentResult({ opponent_username: 'silva.r', is_win: true }),
      dashboardRecentResult({ opponent_username: 'patel.m', is_win: false }),
    ],
    isLoading: false,
    username: 'rita.kovac',
    ...overrides,
  }
}
