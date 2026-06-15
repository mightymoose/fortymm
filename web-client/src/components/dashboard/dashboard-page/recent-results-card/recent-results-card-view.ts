import type { DashboardRecentResult } from '@/api/dashboard'
import { fmtDateShort } from '@/lib/dates'
import { formatRatingDelta } from '@/lib/rating'

// Used wherever an opponent slot has no registered player (the form's
// solo-match path). Matches the label used on the match-details hero and the
// attention panel so the same match reads identically wherever it surfaces.
const NO_OPPONENT_LABEL = 'No opponent'

export interface RecentResultRowView {
  /** Stable key for the row. */
  matchId: string
  /** Avatar seed — null renders the "no opponent" placeholder avatar. */
  opponentName: string | null
  /** Display label — the username, or "No opponent" for a solo match. */
  opponentLabel: string
  /** Whether the viewer won — drives the status dot and score color. */
  isWin: boolean
  /** Games score from the viewer's perspective, e.g. "3-1". */
  score: string
  /** Signed rating delta (e.g. "+12"), or null when the match was unrated. */
  delta: string | null
  /** Short absolute completion date, e.g. "May 3". */
  when: string
}

export interface RecentResultsCardView {
  /** Win-loss tally over the visible window, e.g. "4-1". */
  record: string
  /** How many results are summarized — the "last N" count. */
  count: number
  /** Projected rows in server order (most recent first). */
  rows: RecentResultRowView[]
}

function projectRow(result: DashboardRecentResult): RecentResultRowView {
  return {
    matchId: result.match_id,
    opponentName: result.opponent_username,
    opponentLabel: result.opponent_username ?? NO_OPPONENT_LABEL,
    isWin: result.is_win,
    score: `${result.my_games_won}-${result.opponent_games_won}`,
    delta: result.my_rating_change
      ? formatRatingDelta(result.my_rating_change.delta)
      : null,
    when: fmtDateShort(result.completed_at),
  }
}

/**
 * Project the BFF's recent results into the card's view model: the win-loss
 * record line, the row count, and the per-row display fields (opponent label,
 * score, signed delta, relative date). All label/format derivation lives here
 * so the card stays pure view-in.
 */
export function projectRecentResultsCardView(
  rows: DashboardRecentResult[],
): RecentResultsCardView {
  const wins = rows.filter((row) => row.is_win).length
  return {
    record: `${wins}-${rows.length - wins}`,
    count: rows.length,
    rows: rows.map(projectRow),
  }
}
