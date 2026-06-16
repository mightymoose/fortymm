import type { MatchListRow, MatchStatus } from '@/api/matches'
import type { components } from '@/api/schema'
import { matchDetailRoute, scoringNewRoute } from '@/api/matches'
import { API_TO_TAB, STATUS_TONE } from './match-list-status'
import type {
  MatchListRowView,
  RowActionView,
} from './match-list-table/match-list-row'
import type { FilterTabView } from './filter-row'

type MatchListRowSide = components['schemas']['MatchDetailsSide']

// The current-user-aware attention bucket the server stamps on a row (or null).
export type AttentionKind = NonNullable<MatchListRow['attention']>
// The subset where the user has a move to make — these get a row CTA.
export type ActionableKind = 'dispute' | 'review' | 'score'

const ACTIONABLE_KINDS = new Set<AttentionKind>(['dispute', 'review', 'score'])

function isActionable(kind: AttentionKind | null): kind is ActionableKind {
  return kind !== null && ACTIONABLE_KINDS.has(kind)
}

// Current-user-aware status-chip labels. They replace the ambiguous
// "Awaiting confirmation" with copy that says *who* must act (PRD §"Row Status
// Labels").
const ATTENTION_LABEL: Record<AttentionKind, string> = {
  dispute: 'Disputed',
  review: 'Needs your review',
  score: 'Needs score',
  waiting_opponent: 'Waiting on opponent',
  waiting_others: 'Scheduled',
}

// Chip tone: actionable buckets read as warm/attention; the passive waiting
// rows stay visually quiet so they don't compete with rows that need the user
// (PRD §"Visual Hierarchy").
const ATTENTION_TONE: Record<AttentionKind, string> = {
  dispute: 'status-tone-attention',
  review: 'status-tone-attention',
  score: 'status-tone-attention',
  waiting_opponent: 'status-tone-waiting',
  waiting_others: 'status-tone-scheduled',
}

// Button copy per actionable bucket (PRD §"Row Actions").
const ACTION_LABEL: Record<ActionableKind, string> = {
  dispute: 'Resolve dispute',
  review: 'Review result',
  score: 'Enter score',
}

// Relative urgency among actionable buckets, used to pick the single bucket
// that earns the primary (orange) CTA. Mirrors the server's priority order:
// dispute > review > score. Lower wins.
const ACTIONABLE_RANK: Record<ActionableKind, number> = {
  dispute: 0,
  review: 1,
  score: 2,
}

/** The highest-priority actionable bucket present in a page of rows, or null
 * when none are actionable. Only rows sharing this bucket take the primary CTA;
 * the rest render secondary, so a page never lights up multiple orange buttons
 * for different action types (PRD §"Visual Hierarchy"). */
export function topActionableKind(rows: MatchListRow[]): ActionableKind | null {
  let best: ActionableKind | null = null
  for (const row of rows) {
    const kind = row.attention
    if (
      isActionable(kind) &&
      (best === null || ACTIONABLE_RANK[kind] < ACTIONABLE_RANK[best])
    ) {
      best = kind
    }
  }
  return best
}

/** Players joined by ' & ', or 'No opponent' for a null/empty side. (was sideLabel) */
export function sideLabel(side: MatchListRowSide | null): string {
  return side?.players.map((p) => p.username).join(' & ') || 'No opponent'
}

/** Last 6 chars upper-cased, zero-padded (was shortId). */
export function shortId(id: string): string {
  return id.slice(-6).toUpperCase().padStart(6, '0')
}

/** Relative/absolute 'when' string for the Started column (was TimeCell's
 * body). Pure given a `now` it can default to new Date(). */
export function formatCreatedAt(iso: string, now: Date = new Date()): string {
  const created = new Date(iso)
  const days = Math.floor((now.getTime() - created.getTime()) / 86400000)
  if (days === 0) {
    const hh = String(created.getHours()).padStart(2, '0')
    const mm = String(created.getMinutes()).padStart(2, '0')
    return `${hh}:${mm}`
  }
  if (days === 1) return 'yesterday'
  if (days < 30) return `${days}d ago`
  return created.toLocaleDateString()
}

/** One side projected into the PlayerChip view model. A null side (legacy) or a
 * player-less sentinel side reads as "No opponent" with the ghost avatar. */
function projectPlayerChip(side: MatchListRowSide | null): {
  name: string
  isEmpty: boolean
  isWinner: boolean
} {
  return {
    name: sideLabel(side),
    isEmpty: side === null || side.players.length === 0,
    isWinner: side?.won === true,
  }
}

/** The trailing-cell action for a row, or null for a passive row (waiting /
 * non-participant / final). `score` deep-links to the next un-played game, or
 * to match detail when the board is already decided-but-unposted; review and
 * dispute route to detail, which holds the confirm/dispute/post-result CTAs. */
function projectAction(
  row: MatchListRow,
  primaryKind: ActionableKind | null,
): RowActionView | null {
  const kind = row.attention
  if (!isActionable(kind)) return null
  const route =
    kind === 'score' && row.current_game_number !== null
      ? scoringNewRoute(row.id, row.current_game_number)
      : matchDetailRoute(row.id)
  return { label: ACTION_LABEL[kind], route, primary: kind === primaryKind }
}

/**
 * Project one raw row into the presentational view model the table renders.
 *
 * `primaryKind` (the page's top actionable bucket, from `topActionableKind`)
 * decides which rows' CTAs render primary; pass `null` (the default) when no
 * row is actionable.
 */
export function projectMatchListRow(
  row: MatchListRow,
  primaryKind: ActionableKind | null = null,
): MatchListRowView {
  const tab = API_TO_TAB[row.status]
  const side1 = row.sides.find((s) => s.side_number === 1) ?? row.sides[0]
  const side2 = row.sides.find((s) => s.side_number === 2) ?? null
  const showScore = row.status === 'in_progress' || row.status === 'completed'
  const isLive = row.status === 'in_progress'
  const attention = row.attention

  return {
    id: row.id,
    detailRoute: matchDetailRoute(row.id),
    shortLabel: `M-${shortId(row.id)}`,
    ariaLabel: `Open match: ${sideLabel(side1)} vs ${sideLabel(side2)}`,
    isLive,
    side1: projectPlayerChip(side1),
    side2: projectPlayerChip(side2),
    score: {
      games:
        showScore && side2 !== null
          ? `${side1.games_won}–${side2.games_won}`
          : null,
    },
    status: {
      // A current-user-aware bucket overrides the perspective-neutral
      // status_label so a row says who must act; otherwise fall back to the
      // server label + tab tone.
      label: attention ? ATTENTION_LABEL[attention] : row.status_label,
      toneClass: attention ? ATTENTION_TONE[attention] : STATUS_TONE[tab],
      // Only the plain "Live" chip pulses; an attention-labeled in-progress row
      // (e.g. "Needs your review") shouldn't carry a live dot next to its copy.
      isLive: attention === null && isLive,
    },
    time: { when: formatCreatedAt(row.created_at) },
    action: projectAction(row, primaryKind),
  }
}

/** Build the FilterRow tab descriptors from the static tab list + counts. The
 * Attention tab reads its badge from `attentionCount`; `all` sums the status
 * counts; every other tab reads its own status bucket. */
export function buildFilterTabs(
  tabs: {
    value: FilterTabView['value']
    label: string
    live?: boolean
    attention?: boolean
  }[],
  statusCounts: Record<string, number> | undefined,
  tabToApi: Record<string, MatchStatus>,
  attentionCount: number | undefined,
): FilterTabView[] {
  return tabs.map((tab) => ({
    value: tab.value,
    label: tab.label,
    isLive: tab.live ?? false,
    count: tabCount(tab, statusCounts, tabToApi, attentionCount),
  }))
}

function tabCount(
  tab: { value: FilterTabView['value']; attention?: boolean },
  statusCounts: Record<string, number> | undefined,
  tabToApi: Record<string, MatchStatus>,
  attentionCount: number | undefined,
): number | null {
  if (tab.attention) return attentionCount ?? null
  if (!statusCounts) return null
  if (tab.value === 'all') {
    return Object.values(statusCounts).reduce((a, b) => a + b, 0)
  }
  return statusCounts[tabToApi[tab.value]] ?? 0
}
