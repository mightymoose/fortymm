import type { DashboardRating, DashboardRecentResult } from '@/api/dashboard'

import {
  projectRatingCardView,
  ratingStrategyLabel,
  type RatingCardView,
} from './rating-card/rating-card-view'
import {
  projectRecentResultsCardView,
  type RecentResultsCardView,
} from './recent-results-card/recent-results-card-view'

export interface YourGameRowView {
  /** Section subtitle — strategy + window when rated, else just the window. */
  subtitle: string
  /** Search params for the "Full history" link (the current user's matches). */
  viewAllSearch: { q: string | undefined }
  /** Rating card view, or null when the user isn't in a rated league yet. */
  rating: RatingCardView | null
  /** Recent results card view. */
  recent: RecentResultsCardView
}

/**
 * Shape the "Your game" section: the strategy-aware subtitle, the full-history
 * link target, and the rating/recent card view models (composed from their own
 * projectors). The section component stays pure view-in.
 */
export function projectYourGameRowView(
  rating: DashboardRating | null,
  recent: DashboardRecentResult[],
  username: string | undefined,
): YourGameRowView {
  return {
    subtitle: rating
      ? `${ratingStrategyLabel(rating.strategy_key)} · last 30 days`
      : 'Last 30 days',
    viewAllSearch: { q: username },
    rating: rating ? projectRatingCardView(rating) : null,
    recent: projectRecentResultsCardView(recent),
  }
}
