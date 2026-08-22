import { Overline } from '@/components/overline'
import type { TournamentStatsView } from '../tournament-panel-view'

export interface TournamentStatsStripProps {
  stats: TournamentStatsView
}

/**
 * The three-tile strip beside a tournament event's match card: the viewer's
 * win–loss record, where they stand in their group, and what stage the event is
 * at.
 *
 * The middle tile is the one that can be absent — an event whose draw has not
 * been cut has no standings to stand in — and it renders an em-dash rather than
 * disappearing, so the strip keeps its three-column rhythm between loads.
 */
export const TournamentStatsStrip = ({ stats }: TournamentStatsStripProps) => (
  <dl
    className="flex items-stretch gap-3 rounded-[var(--radius-md)] border border-[color:var(--border-subtle)] bg-[color:var(--bg-card)] px-4 py-3.5"
    data-testid="tournament-panel-stats"
  >
    <div className="min-w-0">
      <Overline as="dt" className="text-[10px]">
        Match record
      </Overline>
      <dd className="font-mono text-[22px] leading-none font-bold tabular-nums">
        {stats.wins}
        <span className="text-[color:var(--fg-3)]">–</span>
        {stats.losses}
      </dd>
    </div>
    <div className="w-px shrink-0 self-stretch bg-[color:var(--border-subtle)]" />
    <div className="min-w-0 flex-1">
      <Overline as="dt" className="text-[10px]">
        {stats.positionLabel}
      </Overline>
      <dd className="leading-none">
        {stats.positionValue === null ? (
          <span className="text-[color:var(--fg-3)] text-[18px]">—</span>
        ) : (
          <>
            <span className="font-mono text-[18px] font-bold">
              {stats.positionValue}
            </span>{' '}
            <span className="text-[13px] text-[color:var(--fg-3)]">
              {stats.positionSuffix}
            </span>
          </>
        )}
      </dd>
    </div>
    <div className="w-px shrink-0 self-stretch bg-[color:var(--border-subtle)]" />
    <div className="min-w-0 flex-1">
      <Overline as="dt" className="text-[10px]">
        Stage
      </Overline>
      <dd className="text-[14px] leading-tight font-semibold">
        {stats.stageValue}
      </dd>
    </div>
  </dl>
)
