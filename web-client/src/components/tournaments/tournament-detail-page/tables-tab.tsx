import { useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'

import { genId } from '../data/helpers'
import type { Tournament, TournamentTable } from '../data/types'
import { SectionHeader } from './section-header'

export interface TablesTabProps {
  tournament: Tournament
  /** This tournament's table catalogue (the venue tables it owns). */
  catalogue: TournamentTable[]
  /** When false (a non-creator), the add-table form and per-row Remove buttons
   * are hidden and the tab is a read-only list of tables. */
  canEdit: boolean
  /** Emit the next catalogue. The catalogue IS the assigned set — the API has
   * no separate global table list, so removing a table drops it outright and
   * the "Add" affordance creates a brand-new table. */
  onChangeCatalogue: (catalogue: TournamentTable[]) => void
}

/** The Tables tab: the venue tables in this tournament's catalogue, each with
 * the events using it, plus a form to add a new table. */
export const TablesTab = ({
  tournament,
  catalogue,
  canEdit,
  onChangeCatalogue,
}: TablesTabProps) => {
  const [label, setLabel] = useState('')
  const [court, setCourt] = useState('')

  const usage = catalogue.map((table) => {
    const usingEvents = tournament.events
      .filter((ev) => ev.pools.some((p) => p.tableIds.includes(table.id)))
      .map((ev) => ev.name)
    return { table, usingEvents }
  })

  const removeTable = (id: string) =>
    onChangeCatalogue(catalogue.filter((t) => t.id !== id))

  const trimmedLabel = label.trim()
  const canAdd = trimmedLabel.length > 0

  const addTable = () => {
    if (!canAdd) return
    onChangeCatalogue([
      ...catalogue,
      { id: genId('table'), label: trimmedLabel, court: court.trim() },
    ])
    setLabel('')
    setCourt('')
  }

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
              {canEdit && (
                <button
                  type="button"
                  aria-label={`Remove ${table.label}`}
                  onClick={() => removeTable(table.id)}
                  className="grid size-7 place-items-center rounded-md text-[color:var(--fg-3)] hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--loss)]"
                >
                  <Trash2 size={14} />
                </button>
              )}
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

      {canEdit && (
        <div className="mt-6">
          <div className="mb-2 text-[11px] font-semibold tracking-[0.12em] text-[color:var(--fg-3)] uppercase">
            Add a table
          </div>
          <form
            className="flex flex-wrap items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault()
              addTable()
            }}
          >
            <Input
              aria-label="Table label"
              placeholder="Label (e.g. T9)"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              className="w-36"
            />
            <Input
              aria-label="Court"
              placeholder="Court"
              value={court}
              onChange={(e) => setCourt(e.target.value)}
              className="w-28"
            />
            <Button type="submit" disabled={!canAdd}>
              <Plus size={14} />
              Add table
            </Button>
          </form>
        </div>
      )}
    </div>
  )
}
