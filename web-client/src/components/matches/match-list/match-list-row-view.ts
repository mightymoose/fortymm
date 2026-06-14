import type { MatchListRow, MatchStatus } from '@/api/matches'
import type { components } from '@/api/schema'
import { matchDetailRoute, scoringNewRoute } from '@/api/matches'
import { API_TO_TAB, STATUS_TONE } from './match-list-status'
import type { MatchListRowView } from './match-list-table/match-list-row'
import type { FilterTabView } from './filter-row'

type MatchListRowSide = components['schemas']['MatchDetailsSide']

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

/** Project one raw row into the presentational view model the table renders. */
export function projectMatchListRow(row: MatchListRow): MatchListRowView {
  const tab = API_TO_TAB[row.status]
  const side1 = row.sides.find((s) => s.side_number === 1) ?? row.sides[0]
  const side2 = row.sides.find((s) => s.side_number === 2) ?? null
  const showScore =
    row.status === 'in_progress' || row.status === 'completed'
  const isLive = row.status === 'in_progress'

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
      label: row.status_label,
      toneClass: STATUS_TONE[tab],
      isLive,
    },
    time: { when: formatCreatedAt(row.created_at) },
    scoreRoute:
      row.current_game_number === null
        ? null
        : scoringNewRoute(row.id, row.current_game_number),
  }
}

/** Build the FilterRow tab descriptors from the static tab list + status_counts. */
export function buildFilterTabs(
  tabs: { value: FilterTabView['value']; label: string; live?: boolean }[],
  statusCounts: Record<string, number> | undefined,
  tabToApi: Record<string, MatchStatus>,
): FilterTabView[] {
  return tabs.map((tab) => ({
    value: tab.value,
    label: tab.label,
    isLive: tab.live ?? false,
    count: !statusCounts
      ? null
      : tab.value === 'all'
        ? Object.values(statusCounts).reduce((a, b) => a + b, 0)
        : statusCounts[tabToApi[tab.value]] ?? 0,
  }))
}
