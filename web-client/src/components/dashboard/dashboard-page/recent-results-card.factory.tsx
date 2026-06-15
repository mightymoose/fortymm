import type { RecentResultsCardProps } from './recent-results-card'
import type {
  RecentResultRowView,
  RecentResultsCardView,
} from './recent-results-card/recent-results-card-view'

/** A won 3-1 rated match against silva.r, completed May 3. */
export function buildRecentResultRowView(
  overrides: Partial<RecentResultRowView> = {},
): RecentResultRowView {
  return {
    matchId: 'm-1',
    opponentName: 'silva.r',
    opponentLabel: 'silva.r',
    isWin: true,
    score: '3-1',
    delta: '+12',
    when: 'May 3',
    ...overrides,
  }
}

/** A card with a single won row — record "1-0", last 1. */
export function buildRecentResultsCardView(
  overrides: Partial<RecentResultsCardView> = {},
): RecentResultsCardView {
  return {
    record: '1-0',
    count: 1,
    rows: [buildRecentResultRowView()],
    ...overrides,
  }
}

/** Props for `RecentResultsCard`. */
export function buildRecentResultsCardProps(
  overrides: Partial<RecentResultsCardProps> = {},
): RecentResultsCardProps {
  return { view: buildRecentResultsCardView(), ...overrides }
}
