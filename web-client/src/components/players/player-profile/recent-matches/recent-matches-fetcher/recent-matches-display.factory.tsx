import type { RecentMatchesDisplayProps } from './recent-matches-display'
import {
  buildLiveRecentMatchRowView,
  buildRecentMatchOpponentView,
  buildRecentMatchRowView,
  buildRecentMatchStatusView,
} from './recent-matches-display/recent-match-row.factory'
import type { RecentMatchesView } from './recent-matches-query'

/**
 * Six recent matches of a player with **fifty** matches to their name.
 *
 * The rows are deliberately mixed — a win, a loss and a live match — because the
 * list is all-inclusive (ADR-0008), and the total is deliberately *not* the
 * decided count: `match_total` counts the matches in play too (ADR-0915).
 */
export function buildRecentMatchesView(
  overrides: Partial<RecentMatchesView> = {},
): RecentMatchesView {
  return {
    playerId: 'p-1',
    rows: [
      buildLiveRecentMatchRowView({
        id: 'm-live',
        opponent: buildRecentMatchOpponentView({ id: 'p-8', name: 'kai.zhou' }),
      }),
      buildRecentMatchRowView({
        id: 'm-1',
        opponent: buildRecentMatchOpponentView({
          id: 'p-9',
          name: 'ada.lovelace',
        }),
      }),
      buildRecentMatchRowView({
        id: 'm-2',
        opponent: buildRecentMatchOpponentView({
          id: 'p-10',
          name: 'grace.hopper',
        }),
        status: buildRecentMatchStatusView({ tone: 'lost', label: 'Lost' }),
        delta: {
          kind: 'change',
          label: '-14',
          ariaLabel: 'Lost 14 rating',
          tone: 'loss',
        },
      }),
    ],
    total: 50,
    viewAllLabel: 'View all 50 matches',
    ...overrides,
  }
}

/** A player with no matches at all: an empty card, and no "View all" link to
 * offer. */
export function buildEmptyRecentMatchesView(
  overrides: Partial<RecentMatchesView> = {},
): RecentMatchesView {
  return buildRecentMatchesView({
    rows: [],
    total: 0,
    viewAllLabel: 'View all 0 matches',
    ...overrides,
  })
}

/** Props for `RecentMatchesDisplay`. */
export function buildRecentMatchesDisplayProps(
  overrides: Partial<RecentMatchesDisplayProps> = {},
): RecentMatchesDisplayProps {
  return { recent: buildRecentMatchesView(), ...overrides }
}
