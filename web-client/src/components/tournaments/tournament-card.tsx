import { MapPin, Trash2 } from 'lucide-react'

import { Card } from '@/components/ui/card'
import { cn } from '@/lib/utils'

import { effectiveDateRange, fmtDateRange, fmtVenueLine } from './data/helpers'
import type { Tournament } from './data/types'
import { StatusBadge } from './status-badge'

export interface TournamentCardProps {
  tournament: Tournament
  onOpen: () => void
  onDelete: () => void
}

function CardStat({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <div className="font-mono text-[20px] leading-none font-bold tabular-nums text-[color:var(--fg-1)]">
        {value}
      </div>
      <div className="mt-1 text-[11px] font-semibold tracking-[0.12em] text-[color:var(--fg-3)] uppercase">
        {label}
      </div>
    </div>
  )
}

/** A tournament summary card for the list grid: status, dates, name, venue,
 * and an events/entries/tables stat row. The whole card opens the tournament;
 * a delete control surfaces on hover, but only for the tournament's creator
 * (`canEdit`) — deleting is owner-only on the server, so a non-creator never
 * sees a button that would 403. */
export const TournamentCard = ({
  tournament: t,
  onOpen,
  onDelete,
}: TournamentCardProps) => {
  const range = effectiveDateRange(t)
  const entries = t.events.reduce((sum, e) => sum + (e.entered || 0), 0)
  // Empty when the tournament has no venue, city, or region — and then the
  // whole line goes, pin and all. A row holding only its own punctuation is not
  // information (#994).
  const venue = fmtVenueLine(t.address)

  return (
    <div className="group/tcard relative">
      <Card
        className={cn(
          'gap-3 px-4 ring-[color:var(--border-subtle)] transition-colors',
          'group-hover/tcard:ring-[color:var(--border-default)]',
        )}
      >
        <div className="flex flex-wrap items-center gap-2.5">
          <StatusBadge status={t.status} />
          <span className="font-mono text-[11px] tracking-[0.04em] text-[color:var(--fg-3)]">
            {range.start ? fmtDateRange(range.start, range.end) : 'Dates TBD'}
          </span>
        </div>

        <div>
          <div className="text-[20px] leading-tight font-bold tracking-[-0.01em] text-[color:var(--fg-1)]">
            {t.name}
          </div>
          {venue && (
            <div
              data-testid="tournament-venue-line"
              className="mt-1 flex items-center gap-1 text-[13px] text-[color:var(--fg-3)]"
            >
              <MapPin size={12} />
              {venue}
            </div>
          )}
        </div>

        <div className="mt-1 grid grid-cols-3 gap-2.5 border-t border-[color:var(--border-subtle)] pt-3">
          <CardStat label="Events" value={t.events.length} />
          <CardStat label="Entries" value={entries} />
          <CardStat label="Tables" value={t.tableIds.length} />
        </div>
      </Card>

      {/* Full-card open target sits beneath the delete control. */}
      <button
        type="button"
        aria-label={t.name}
        onClick={onOpen}
        className="absolute inset-0 z-0 rounded-xl outline-offset-2"
      />
      {t.canEdit && (
        <button
          type="button"
          aria-label={`Delete ${t.name}`}
          onClick={onDelete}
          className="absolute top-2.5 right-2.5 z-10 grid size-7 place-items-center rounded-md text-[color:var(--fg-3)] opacity-0 transition-opacity group-hover/tcard:opacity-100 hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--loss)] focus-visible:opacity-100"
        >
          <Trash2 size={14} />
        </button>
      )}
    </div>
  )
}
