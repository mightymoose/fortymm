import { matchDetailRoute, scoringNewRoute } from '@/api/matches'
import type { DashboardAttentionItem } from '@/api/dashboard'

// Used wherever an opponent slot has no registered player — matches the label
// the rest of the dashboard uses for solo matches.
const NO_OPPONENT_LABEL = 'No opponent'

// The panel never grows unbounded — show the top 3 rows, roll the rest into
// the footer (PRD §6.4).
export const ATTENTION_VISIBLE_LIMIT = 3

type RowRoute =
  | ReturnType<typeof matchDetailRoute>
  | ReturnType<typeof scoringNewRoute>

export interface AttentionRowView {
  matchId: string
  /** Avatar seed — null renders the "no opponent" placeholder avatar. */
  opponentName: string | null
  /** Row headline, e.g. `vs nguyen.t` or `No opponent`. */
  headline: string
  /** Button copy: `Review result` | `Enter score`. */
  actionLabel: string
  /** Whether this row takes the primary (filled) button — true for every row
   * in the highest-priority bucket currently visible (PRD §6.3). */
  primary: boolean
  /** Where the button routes: match detail for a review, the scoring
   * page for a score row (or match detail when the board is already decided). */
  route: RowRoute
}

export interface AttentionPanelView {
  /** The (≤3) rows to render, in server-supplied priority order. */
  rows: AttentionRowView[]
  /** Actionable items beyond the visible 3 — footer "N more need attention". */
  overflowCount: number
  /** Matches waiting on someone else — footer "N waiting on others". */
  waitingCount: number
  /** Search params for the "View all" link — opens /matches on the Attention
   * tab so the same priority-ranked set the panel previews fills the page
   * (PRD §"Dashboard Integration"). */
  viewAllSearch: { status: 'attention' }
}

// A row's attention "bucket" — the unit the primary-button rule operates on.
// It is keyed by the action *kind* (the button copy: review / score)
// so same-type rows always share styling: all `Enter score` rows render primary
// together or secondary together, regardless of rated-vs-unrated (PRD §6.3 —
// "multiple same-type actionable items → all primary"). The rated/unrated split
// only affects priority *ordering*, which the server already applies (PRD §5),
// so the first visible row is the highest-priority bucket present and every row
// sharing its kind takes the primary button.
function bucketKey(item: DashboardAttentionItem): string {
  return item.kind
}

function actionLabelOf(kind: DashboardAttentionItem['kind']): string {
  if (kind === 'review') return 'Review result'
  return 'Enter score'
}

function routeOf(item: DashboardAttentionItem): RowRoute {
  // A score row deep-links to the next un-played game; review rows (and
  // a decided-but-unposted board, current_game_number === null) route to match
  // detail, which holds the accept/counter/post-result actions.
  if (item.kind === 'score' && item.current_game_number !== null) {
    return scoringNewRoute(item.match_id, item.current_game_number)
  }
  return matchDetailRoute(item.match_id)
}

/**
 * Whether the panel has nothing actionable to show. The panel is purely a
 * to-do list: it hides entirely whenever there are no actionable rows, even if
 * matches are still waiting on others — there's nothing for the user to do, so
 * the dashboard stays calm rather than showing a standing "all caught up" card.
 * (`rows.length === 0` already implies `overflowCount === 0`, since overflow
 * only exists once the visible rows fill.)
 */
export function isAttentionPanelEmpty(view: AttentionPanelView): boolean {
  return view.rows.length === 0
}

/**
 * Project the BFF's pre-ranked attention items into the panel's view model:
 * cap visible rows at 3, compute the footer counts, and mark the
 * highest-priority *visible* bucket as primary (so a `Review result` beneath a
 * `Enter score` renders secondary). Items arrive already sorted by the
 * server (PRD §5), so their order is preserved as-is.
 *
 * `attentionTotalCount` is the server's exact actionable-match total. The
 * `items` array is itself capped server-side (`ATTENTION_BANNERS_LIMIT`), so
 * overflow is derived from this total — not from `items.length`, which would
 * under-count once the cap bites. Defaults to `items.length` for callers that
 * pass an uncapped set.
 */
export function projectAttentionPanelView(
  items: DashboardAttentionItem[],
  waitingCount: number,
  attentionTotalCount: number = items.length,
): AttentionPanelView {
  const visible = items.slice(0, ATTENTION_VISIBLE_LIMIT)
  // Items arrive pre-sorted by priority, so the first visible row defines the
  // top bucket; rows sharing it render primary.
  const topBucket = visible.length ? bucketKey(visible[0]) : ''
  return {
    rows: visible.map((item) => ({
      matchId: item.match_id,
      opponentName: item.opponent_username,
      headline: item.opponent_username
        ? `vs ${item.opponent_username}`
        : NO_OPPONENT_LABEL,
      actionLabel: actionLabelOf(item.kind),
      primary: bucketKey(item) === topBucket,
      route: routeOf(item),
    })),
    overflowCount: Math.max(0, attentionTotalCount - ATTENTION_VISIBLE_LIMIT),
    waitingCount,
    viewAllSearch: { status: 'attention' },
  }
}
