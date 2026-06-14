import { Calendar } from 'lucide-react'

import { Card } from '@/components/ui/card'

import { fmtDate } from '../data/helpers'
import type { Pool, Tournament, TournamentEvent } from '../data/types'
import { EmptyState } from '../empty-state'
import { SectionHeader } from './section-header'

export interface ScheduleTabProps {
  tournament: Tournament
}

const DAY_START = 8 * 60
const DAY_END = 22 * 60
const HOURS = [8, 10, 12, 14, 16, 18, 20, 22]

function timeToMin(t: string): number {
  const [h, m] = t.split(':').map(Number)
  return h * 60 + m
}
function pct(t: string): number {
  return ((timeToMin(t) - DAY_START) / (DAY_END - DAY_START)) * 100
}

interface Slotted {
  event: TournamentEvent
  pool: Pool
}

/** The Schedule tab: a read-only timeline of how each event's pools land on the
 * calendar, grouped by day, on an 8:00–22:00 scale. */
export const ScheduleTab = ({ tournament }: ScheduleTabProps) => {
  const byDay = new Map<string, Slotted[]>()
  for (const event of tournament.events) {
    for (const pool of event.pools) {
      const list = byDay.get(pool.slot.date) ?? []
      list.push({ event, pool })
      byDay.set(pool.slot.date, list)
    }
  }
  const days = [...byDay.keys()].sort()

  return (
    <div>
      <SectionHeader
        title="Schedule"
        subtitle="Read-only view of how pools land on the calendar. Conflicts flag in events."
      />

      {days.length === 0 ? (
        <EmptyState
          icon={<Calendar size={28} />}
          title="Nothing scheduled"
          hint="Add pools to events to see them here."
        />
      ) : (
        <div className="flex flex-col gap-6">
          {days.map((date) => {
            const rows = byDay.get(date) ?? []
            return (
              <div key={date}>
                <div className="mb-2.5 flex items-center gap-2.5">
                  <div className="font-display text-[28px] tracking-[0.02em] text-[color:var(--fg-1)] uppercase">
                    {fmtDate(date)}
                  </div>
                  <span className="rounded-full bg-[color:var(--bg-raised)] px-2 py-0.5 font-mono text-[11px] text-[color:var(--fg-2)]">
                    {rows.length} pools
                  </span>
                </div>
                <Card className="gap-0 p-0">
                  <div className="grid grid-cols-[180px_1fr] border-b border-[color:var(--border-subtle)] font-mono text-[11px] text-[color:var(--fg-3)]">
                    <div className="px-4 py-2.5">Event / pool</div>
                    <div className="relative py-2.5">
                      {HOURS.map((h) => (
                        <div
                          key={h}
                          className="absolute top-0 bottom-0 pl-1"
                          style={{
                            left: `${((h * 60 - DAY_START) / (DAY_END - DAY_START)) * 100}%`,
                          }}
                        >
                          {h}:00
                        </div>
                      ))}
                    </div>
                  </div>
                  {rows.map(({ event, pool }, i) => (
                    <div
                      key={pool.id}
                      className="grid min-h-14 grid-cols-[180px_1fr] items-center"
                      style={{
                        borderBottom:
                          i === rows.length - 1
                            ? 'none'
                            : '1px solid var(--border-subtle)',
                      }}
                    >
                      <div className="px-4 py-2.5">
                        <div className="text-[13px] font-semibold text-[color:var(--fg-1)]">
                          {event.name}
                        </div>
                        <div className="text-[11px] text-[color:var(--fg-3)]">
                          {pool.name} · {pool.tableIds.length} tables
                        </div>
                      </div>
                      <div className="relative mr-3 h-8">
                        {HOURS.map((h) => (
                          <div
                            key={h}
                            className="absolute top-0 bottom-0 w-px bg-[color:var(--border-subtle)]"
                            style={{
                              left: `${((h * 60 - DAY_START) / (DAY_END - DAY_START)) * 100}%`,
                            }}
                          />
                        ))}
                        <div
                          className="absolute top-1 bottom-1 flex items-center gap-1.5 overflow-hidden rounded-[4px] border border-[color:rgba(255,122,26,0.5)] px-2 whitespace-nowrap"
                          style={{
                            left: `${pct(pool.slot.start)}%`,
                            width: `${pct(pool.slot.end) - pct(pool.slot.start)}%`,
                            background:
                              'linear-gradient(90deg, rgba(255,122,26,0.3), rgba(255,122,26,0.15))',
                          }}
                        >
                          <span className="font-mono text-[11px] font-bold text-[color:var(--ball-500)]">
                            {pool.slot.start}–{pool.slot.end}
                          </span>
                          <span className="text-[11px] text-[color:var(--fg-2)]">
                            {pool.tableIds.length}×
                          </span>
                        </div>
                      </div>
                    </div>
                  ))}
                </Card>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
