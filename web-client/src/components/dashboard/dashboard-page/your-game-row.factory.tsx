import type { YourGameRowProps } from './your-game-row'
import type { YourGameRowView } from './your-game-row/your-game-row-view'
import { buildRatingCardView } from './your-game-row/rating-card.factory'
import { buildRecentResultsCardView } from './your-game-row/recent-results-card.factory'

/** A rated section: Glicko-2 subtitle, rita.kovac's history, both cards filled. */
export function buildYourGameRowView(
  overrides: Partial<YourGameRowView> = {},
): YourGameRowView {
  return {
    subtitle: 'Glicko-2 · last 30 days',
    viewAllSearch: { q: 'rita.kovac' },
    rating: buildRatingCardView(),
    recent: buildRecentResultsCardView(),
    ...overrides,
  }
}

/** Props for `YourGameRow` — loaded (not skeleton) by default. */
export function buildYourGameRowProps(
  overrides: Partial<YourGameRowProps> = {},
): YourGameRowProps {
  return { view: buildYourGameRowView(), isLoading: false, ...overrides }
}
