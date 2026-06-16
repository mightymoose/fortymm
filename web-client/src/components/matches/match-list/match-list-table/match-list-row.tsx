import { Link, useRouter } from '@tanstack/react-router'

import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { matchDetailRoute, scoringNewRoute } from '@/api/matches'

import { PlayerChip, type PlayerChipView } from './match-list-row/player-chip'
import { ScoreCell, type ScoreCellView } from './match-list-row/score-cell'
import { StatusBadge, type StatusBadgeView } from './match-list-row/status-badge'
import { TimeCell, type TimeCellView } from './match-list-row/time-cell'
import type { NavigateFn } from '../match-list-status'

/** The trailing-cell CTA for an actionable row (Enter score / Review result /
 * Resolve dispute). Passive rows (waiting / final / non-participant) carry
 * `action: null` and render no button. `primary` is true only for the page's
 * top actionable bucket, which takes the filled orange button. */
export interface RowActionView {
  /** Button copy. */
  label: string
  /** Navigation target — the scoring page (score rows with a next game) or
   * match detail (review/dispute, or a decided-but-unposted board). */
  route:
    | ReturnType<typeof matchDetailRoute>
    | ReturnType<typeof scoringNewRoute>
  /** Whether this row takes the primary (filled) button vs. the secondary one. */
  primary: boolean
}

export interface MatchListRowView {
  /** Stable React key + used for navigation/preload targets. The raw match id. */
  id: string
  /** 'M-XXXXXX' id cell text, pre-computed via shortId. */
  shortLabel: string
  /** True for in_progress rows — adds the is-live class (the orange rail). */
  isLive: boolean
  /** aria-label for the clickable row, e.g. 'Open match: a & b vs No opponent'. Pre-built from the two side labels. */
  ariaLabel: string
  side1: PlayerChipView
  side2: PlayerChipView
  score: ScoreCellView
  status: StatusBadgeView
  time: TimeCellView
  /** The {to,params} navigation target for the whole-row click + hover preload. */
  detailRoute: ReturnType<typeof matchDetailRoute>
  /** The trailing-cell action, or null for a passive row (no button). */
  action: RowActionView | null
}

export interface MatchListRowProps {
  row: MatchListRowView
  navigate: NavigateFn
}

export const MatchListRow = ({ row, navigate }: MatchListRowProps) => {
  const router = useRouter()

  function open() {
    void navigate(row.detailRoute)
  }

  // The row is a clickable <tr>, not a <Link>, so router intent-preloading
  // doesn't apply automatically. Warm the match-details loader on hover/focus.
  function preload() {
    void router.preloadRoute(row.detailRoute)
  }

  return (
    <tr
      className={cn('is-clickable', row.isLive && 'is-live')}
      role="link"
      tabIndex={0}
      aria-label={row.ariaLabel}
      onClick={open}
      onMouseEnter={preload}
      onFocus={preload}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          open()
        }
      }}
    >
      <td className="id-cell">{row.shortLabel}</td>
      <td>
        <div className="players-cell">
          <PlayerChip chip={row.side1} />
          <span className="players-vs">vs</span>
          <PlayerChip chip={row.side2} />
        </div>
      </td>
      <td>
        <ScoreCell score={row.score} />
      </td>
      <td>
        <StatusBadge status={row.status} />
      </td>
      <td>
        <TimeCell time={row.time} />
      </td>
      <td onClick={(e) => e.stopPropagation()}>
        {row.action !== null ? (
          <Button
            asChild
            variant={row.action.primary ? 'default' : 'outline'}
            size="sm"
          >
            <Link {...row.action.route}>{row.action.label}</Link>
          </Button>
        ) : null}
      </td>
    </tr>
  )
}
