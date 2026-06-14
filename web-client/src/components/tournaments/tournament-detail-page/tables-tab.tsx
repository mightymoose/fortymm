import { Plus, Trash2 } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Card } from '@/components/ui/card'

import type { Tournament, TournamentTable } from '../data/types'
import { SectionHeader } from './section-header'

export interface TablesTabProps {
  tournament: Tournament
  /** The full table catalogue. */
  allTables: TournamentTable[]
  onUpdate: (tournament: Tournament) => void
}

/** The Tables tab: the venue tables assigned to this tournament, each with the
 * events using it, plus a row of unassigned tables to add. */
export const TablesTab = ({ tournament, allTables, onUpdate }: TablesTabProps) => {
  const usage = tournament.tableIds
    .map((id) => {
      const table = allTables.find((t) => t.id === id)
      const usingEvents = tournament.events
        .filter((ev) => ev.pools.some((p) => p.tableIds.includes(id)))
        .map((ev) => ev.name)
      return table ? { table, usingEvents } : null
    })
    .filter((u): u is { table: TournamentTable; usingEvents: string[] } => u !== null)

  const available = allTables.filter((t) => !tournament.tableIds.includes(t.id))

  const removeTable = (id: string) =>
    onUpdate({ ...tournament, tableIds: tournament.tableIds.filter((x) => x !== id) })
  const addTable = (id: string) =>
    onUpdate({ ...tournament, tableIds: [...tournament.tableIds, id] })

  return (
    <div>
      <SectionHeader
        title="Tables"
        subtitle="The physical tables available at this venue. Add them to pools when configuring events."
      />

      <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-3">
        {usage.map(({ table, usingEvents }) => (
          <Card key={table.id} className="gap-2.5 px-4">
            <div className="flex items-center gap-2.5">
              <div className="relative h-7 w-11 shrink-0 rounded-[3px] border border-[color:rgba(255,122,26,0.3)] bg-[color:var(--bg-accent-soft)]">
                <div className="absolute top-1/2 right-0 left-0 h-px bg-[color:var(--ball-500)] opacity-50" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="font-mono text-[15px] font-bold text-[color:var(--fg-1)]">
                  {table.label}
                </div>
                <div className="text-[11px] text-[color:var(--fg-3)]">
                  Court {table.court}
                </div>
              </div>
              <button
                type="button"
                aria-label={`Remove ${table.label}`}
                onClick={() => removeTable(table.id)}
                className="grid size-7 place-items-center rounded-md text-[color:var(--fg-3)] hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--loss)]"
              >
                <Trash2 size={14} />
              </button>
            </div>
            {usingEvents.length > 0 ? (
              <div className="flex flex-wrap gap-1">
                {usingEvents.map((n, i) => (
                  <Badge
                    key={i}
                    variant="ghost"
                    className="border-[color:var(--border-subtle)]"
                  >
                    {n}
                  </Badge>
                ))}
              </div>
            ) : (
              <div className="text-[11px] text-[color:var(--fg-3)] italic">
                Unused
              </div>
            )}
          </Card>
        ))}
      </div>

      {available.length > 0 && (
        <div className="mt-6">
          <div className="mb-2 text-[11px] font-semibold tracking-[0.12em] text-[color:var(--fg-3)] uppercase">
            Add a table · {available.length} available
          </div>
          <div className="flex flex-wrap gap-2">
            {available.map((t) => (
              <button
                key={t.id}
                type="button"
                aria-label={`Add ${t.label}`}
                onClick={() => addTable(t.id)}
                className="inline-flex items-center gap-1.5 rounded-md border border-[color:var(--border-default)] bg-[color:var(--bg-card)] px-3 py-2 font-mono text-[13px] text-[color:var(--fg-1)] hover:bg-[color:var(--bg-hover)]"
              >
                <Plus size={12} />
                {t.label}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
