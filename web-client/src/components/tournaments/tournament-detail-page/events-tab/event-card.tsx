import { ChevronRight, Layers, Pencil, TrendingUp } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Card } from '@/components/ui/card'
import { cn } from '@/lib/utils'

import { fmtDateShort, formatPredicate } from '../../data/helpers'
import { DRAW_TYPE_OPTIONS, FORMAT_OPTIONS } from '../../data/options'
import type { TournamentEvent } from '../../data/types'

export interface EventCardProps {
  event: TournamentEvent
  onOpen: () => void
}

/** A row card for one event on the tournament's Events tab: title with rated /
 * best-of badges, eligibility chips, the time slot, pool/table counts, and an
 * entries fill bar. The whole card opens the editor. */
export const EventCard = ({ event: ev, onOpen }: EventCardProps) => {
  const fillPct = ev.maxPlayers
    ? Math.min(100, Math.round(((ev.entered || 0) / ev.maxPlayers) * 100))
    : 0
  const isFull = ev.entered >= ev.maxPlayers
  const formatLabel =
    FORMAT_OPTIONS.find((f) => f.value === ev.format)?.label ?? ev.format
  const drawLabel =
    DRAW_TYPE_OPTIONS.find((d) => d.value === ev.drawType)?.label ?? ev.drawType
  const tableCount = new Set(ev.pools.flatMap((p) => p.tableIds)).size

  return (
    <div className="group/ecard relative">
      <Card className="p-0 ring-[color:var(--border-subtle)] transition-colors group-hover/ecard:ring-[color:var(--border-default)]">
        <div className="grid grid-cols-[minmax(0,2.4fr)_minmax(0,1fr)_minmax(0,1fr)_auto] items-center gap-6 p-[18px]">
          <div className="min-w-0">
            <div className="mb-1.5 flex flex-wrap items-center gap-2.5">
              <span className="text-[20px] font-bold whitespace-nowrap text-[color:var(--fg-1)]">
                {ev.name}
              </span>
              {ev.match.rated && (
                <Badge
                  variant="outline"
                  className="border-[color:rgba(255,122,26,0.3)] bg-[color:var(--bg-accent-soft)] text-[color:var(--ball-500)]"
                >
                  <TrendingUp size={12} />
                  Rated
                </Badge>
              )}
              <Badge variant="outline" className="font-mono">
                Bo{ev.match.lengthGames}
              </Badge>
            </div>
            <div className="flex items-center gap-2 text-[13px] whitespace-nowrap text-[color:var(--fg-3)]">
              <span>{formatLabel}</span>
              <span>·</span>
              <span>{drawLabel}</span>
            </div>
            {ev.predicates.length > 0 && (
              <div className="mt-2.5 flex flex-wrap gap-1">
                {ev.predicates.map((p) => (
                  <Badge key={p.id} variant="ghost" className="border-[color:var(--border-subtle)]">
                    {formatPredicate(p)}
                  </Badge>
                ))}
              </div>
            )}
          </div>

          <div className="min-w-0">
            <div className="text-[11px] font-semibold tracking-[0.12em] text-[color:var(--fg-3)] uppercase">
              Time slot
            </div>
            <div className="mt-1 font-mono text-[13px] tabular-nums text-[color:var(--fg-1)]">
              {fmtDateShort(ev.slot.date)} · {ev.slot.start}–{ev.slot.end}
            </div>
            <div className="mt-1.5 flex items-center gap-1.5 text-[11px] whitespace-nowrap text-[color:var(--fg-3)]">
              <Layers size={12} />
              <span>
                {ev.pools.length} {ev.pools.length === 1 ? 'pool' : 'pools'}
              </span>
              <span>·</span>
              <span className="font-mono">{tableCount} tables</span>
            </div>
          </div>

          <div className="min-w-0">
            <div className="text-[11px] font-semibold tracking-[0.12em] text-[color:var(--fg-3)] uppercase">
              Entries
            </div>
            <div className="mt-1 flex items-baseline gap-1">
              <span
                className={cn(
                  'font-mono text-[20px] font-bold tabular-nums',
                  isFull ? 'text-[color:var(--warn)]' : 'text-[color:var(--fg-1)]',
                )}
              >
                {ev.entered || 0}
              </span>
              <span className="font-mono text-[13px] text-[color:var(--fg-3)]">
                / {ev.maxPlayers}
              </span>
            </div>
            <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-[color:var(--bg-panel)]">
              <div
                className={cn(
                  'h-full',
                  isFull ? 'bg-[color:var(--warn)]' : 'bg-[color:var(--ball-500)]',
                )}
                style={{ width: `${fillPct}%` }}
              />
            </div>
          </div>

          <div className="flex items-center gap-2">
            <span className="pointer-events-none inline-flex h-8 items-center gap-1.5 rounded-[10px] border border-[color:var(--border-default)] px-3 text-[13px] font-medium text-[color:var(--fg-1)]">
              <Pencil size={14} />
              Edit
            </span>
            <ChevronRight size={16} className="text-[color:var(--fg-3)]" />
          </div>
        </div>
      </Card>

      <button
        type="button"
        aria-label={`Edit ${ev.name}`}
        onClick={onOpen}
        className="absolute inset-0 rounded-xl outline-offset-2"
      />
    </div>
  )
}
