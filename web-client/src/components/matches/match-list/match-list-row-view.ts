import { differenceInCalendarDays } from 'date-fns'
import { z } from 'zod'

import type { MatchListFilter, MatchListRow } from '@/api/matches'
import type { components } from '@/api/schema'
import { matchDetailRoute, scoringNewRoute } from '@/api/matches'
import { parseApiDate } from '@/lib/dates'
import { API_TO_TONE, STATUS_TONE, type StatusKey } from './match-list-status'
import type {
  MatchListRowView,
  RowActionView,
} from './match-list-table/match-list-row'
import type { FilterTabView } from './filter-row'

type MatchListRowSide = components['schemas']['MatchDetailsSide']
type MatchNegotiation = components['schemas']['MatchNegotiation']

// The server-derived label for a posted-but-unaccepted result (an in_progress
// match with a standing proposed result; see `_status_label` in the API). When
// the row has no current-user-aware attention bucket, the list re-tones these
// rows to the dedicated "awaiting" treatment — they share the `in_progress` DB
// status with true-live rows but aren't live anymore (issue #381).
export const AWAITING_ACCEPTANCE_LABEL = 'Awaiting acceptance'

// The current-user-aware attention bucket the server stamps on a row (or null).
export type AttentionKind = NonNullable<MatchListRow['attention']>
// The subset where the user has a move to make — these get a row CTA.
export type ActionableKind = 'review' | 'score'

// The retirement deadline as it arrives on the negotiation block: an ISO
// datetime string, null, or absent. Parsed at this projection boundary and
// soft-failed to null (`.catch`) — a malformed deadline drops the countdown
// rather than throwing and blanking the row. Mirrors `parseRetirementDeadline`
// in the match-details confirmation-callout query.
const retirementDeadlineSchema = z
  .string()
  .datetime({ offset: true })
  .nullable()
  .catch(null)

const parseRetirementDeadline = (value: unknown): string | null =>
  retirementDeadlineSchema.parse(value ?? null)

// The negotiation states in which the viewer is the one who must respond before
// the deadline — the only states where a "N left to respond" countdown is
// truthful. The server stamps `retirement_deadline` on every state (including
// `awaiting`, where the viewer already proposed and waits on the opponent), so
// the row must gate the cue on whose turn it is, exactly as the match-details
// confirmation-callout does (it only surfaces the deadline for review/corrected).
const VIEWER_MUST_RESPOND_STATES = new Set<
  MatchNegotiation['viewer_state']
>(['review', 'corrected'])

/** The retirement deadline to surface on a row: the parsed negotiation deadline
 * when the viewer must respond (review/corrected), else null — so a row the
 * viewer is merely waiting on never shows a "left to respond" countdown. */
function projectRetirementDeadline(
  negotiation: MatchNegotiation,
): string | null {
  if (!VIEWER_MUST_RESPOND_STATES.has(negotiation.viewer_state)) return null
  return parseRetirementDeadline(negotiation.retirement_deadline)
}

const ACTIONABLE_KINDS = new Set<AttentionKind>(['review', 'score'])

function isActionable(kind: AttentionKind | null): kind is ActionableKind {
  return kind !== null && ACTIONABLE_KINDS.has(kind)
}

// Current-user-aware status-chip labels. They replace the ambiguous
// "Awaiting acceptance" with copy that says *who* must act (PRD §"Row Status
// Labels").
const ATTENTION_LABEL: Record<AttentionKind, string> = {
  review: 'Needs your review',
  score: 'Needs score',
  waiting_opponent: 'Waiting on opponent',
  waiting_others: 'Scheduled',
}

// Chip tone: actionable buckets read as warm/attention; the passive waiting
// rows stay visually quiet so they don't compete with rows that need the user
// (PRD §"Visual Hierarchy").
const ATTENTION_TONE: Record<AttentionKind, string> = {
  review: 'status-tone-attention',
  score: 'status-tone-attention',
  waiting_opponent: 'status-tone-waiting',
  waiting_others: 'status-tone-scheduled',
}

// Button copy per actionable bucket (PRD §"Row Actions").
const ACTION_LABEL: Record<ActionableKind, string> = {
  review: 'Review result',
  score: 'Enter score',
}

// Relative urgency among actionable buckets, used to pick the single bucket
// that earns the primary (orange) CTA. Mirrors the server's priority order:
// review > score. Lower wins.
const ACTIONABLE_RANK: Record<ActionableKind, number> = {
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
  const created = parseApiDate(iso)
  const days = differenceInCalendarDays(now, created)
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
 * to match detail when the board is already decided-but-unposted; review
 * routes to detail, which holds the accept/counter/post-result CTAs. */
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
  const attention = row.attention
  // An in_progress row with a posted result reads as "Awaiting acceptance",
  // not Live — re-tone it and drop the live-dot so it stops masquerading as a
  // live match (issue #381). The DB status is still in_progress, so the
  // games-score still shows. A current-user-aware attention bucket takes
  // precedence over this perspective-neutral re-toning (see the status chip
  // below).
  const isAwaiting =
    row.status === 'in_progress' &&
    row.status_label === AWAITING_ACCEPTANCE_LABEL
  const tone: StatusKey = isAwaiting ? 'awaiting' : API_TO_TONE[row.status]
  const side1 = row.sides.find((s) => s.side_number === 1) ?? row.sides[0]
  const side2 = row.sides.find((s) => s.side_number === 2) ?? null
  const showScore = row.status === 'in_progress' || row.status === 'completed'
  const isLive = row.status === 'in_progress' && !isAwaiting

  return {
    id: row.id,
    detailRoute: matchDetailRoute(row.id),
    shortLabel: `M-${shortId(row.id)}`,
    // A null or player-less sentinel side 2 both render as "No opponent"; read
    // that to the screen reader as a clause rather than an awkward "vs No
    // opponent" (#175).
    ariaLabel: side2?.players.length
      ? `Open match: ${sideLabel(side1)} vs ${sideLabel(side2)}`
      : `Open match: ${sideLabel(side1)} (no opponent)`,
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
      // server label + (awaiting-aware) status tone.
      label: attention ? ATTENTION_LABEL[attention] : row.status_label,
      toneClass: attention ? ATTENTION_TONE[attention] : STATUS_TONE[tone],
      // Only the plain "Live" chip pulses; an attention-labeled in-progress row
      // (e.g. "Needs your review") or an awaiting-acceptance row shouldn't
      // carry a live dot next to its copy.
      isLive: attention === null && isLive,
    },
    time: { when: formatCreatedAt(row.created_at) },
    action: projectAction(row, primaryKind),
    retirementDeadline: projectRetirementDeadline(row.negotiation),
  }
}

/** Build the FilterRow tab descriptors from the static tab list + counts.
 *
 * The Attention tab reads its badge from `attentionCount` (its own server
 * dimension). The status-backed tabs bucket exactly the way the server splits
 * the list: `live` reads the (already awaiting-subtracted) `in_progress` count,
 * the `awaiting` tab reads the dedicated `awaitingCount`, and `all` sums every
 * status bucket plus the awaiting bucket — so a posted-but-unconfirmed result is
 * counted once, under Awaiting, never under Live (issue #381). */
export function buildFilterTabs(
  tabs: {
    value: FilterTabView['value']
    label: string
    live?: boolean
    attention?: boolean
  }[],
  statusCounts: Record<string, number> | undefined,
  tabToApi: Record<string, MatchListFilter>,
  counts: { attentionCount?: number; awaitingCount?: number } = {},
): FilterTabView[] {
  return tabs.map((tab) => ({
    value: tab.value,
    label: tab.label,
    isLive: tab.live ?? false,
    count: tabCount(tab, statusCounts, tabToApi, counts),
  }))
}

function tabCount(
  tab: { value: FilterTabView['value']; attention?: boolean },
  statusCounts: Record<string, number> | undefined,
  tabToApi: Record<string, MatchListFilter>,
  { attentionCount, awaitingCount }: { attentionCount?: number; awaitingCount?: number },
): number | null {
  // The Attention tab is its own server dimension — its badge reads from
  // `attentionCount`, independent of `status_counts`.
  if (tab.attention) return attentionCount ?? null
  if (!statusCounts) return null
  // `all` sums every status bucket plus the awaiting bucket (the awaiting count
  // is peeled out of the in_progress status count server-side, issue #381).
  if (tab.value === 'all') {
    return (
      Object.values(statusCounts).reduce((a, b) => a + b, 0) +
      (awaitingCount ?? 0)
    )
  }
  // `awaiting` reads its dedicated bucket; `live` reads the
  // (already awaiting-subtracted) in_progress count — disjoint (issue #381).
  if (tabToApi[tab.value] === 'awaiting_acceptance') {
    return awaitingCount ?? 0
  }
  return statusCounts[tabToApi[tab.value]] ?? 0
}
