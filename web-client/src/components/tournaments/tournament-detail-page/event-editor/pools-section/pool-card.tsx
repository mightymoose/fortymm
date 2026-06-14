import { Trash2 } from 'lucide-react'

import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'

import type { Pool, TournamentTable } from '../../../data/types'
import { Field } from '../../../field'

export interface PoolCardProps {
  pool: Pool
  /** The tables available to this tournament. */
  tables: TournamentTable[]
  onChange: (pool: Pool) => void
  onRemove: () => void
}

/** A single table pool: a name, a date/start/end window, and a multi-select of
 * the tournament's tables (rendered as toggle chips). */
export const PoolCard = ({ pool, tables, onChange, onRemove }: PoolCardProps) => {
  const setSlot = (patch: Partial<Pool['slot']>) =>
    onChange({ ...pool, slot: { ...pool.slot, ...patch } })

  const toggleTable = (id: string) =>
    onChange({
      ...pool,
      tableIds: pool.tableIds.includes(id)
        ? pool.tableIds.filter((x) => x !== id)
        : [...pool.tableIds, id],
    })

  return (
    <Card className="gap-0 p-0" data-testid="pool-card">
      <div className="flex items-center gap-2.5 border-b border-[color:var(--border-subtle)] p-3.5">
        <Input
          aria-label="Pool name"
          value={pool.name}
          onChange={(e) => onChange({ ...pool, name: e.target.value })}
          className="h-8 flex-1 border-transparent bg-transparent text-[15px] font-semibold shadow-none focus-visible:border-[color:var(--border-default)]"
        />
        <span className="rounded-full bg-[color:var(--bg-raised)] px-2 py-0.5 font-mono text-[11px] text-[color:var(--fg-2)]">
          {pool.tableIds.length}{' '}
          {pool.tableIds.length === 1 ? 'table' : 'tables'}
        </span>
        <button
          type="button"
          aria-label="Remove pool"
          onClick={onRemove}
          className="grid size-7 place-items-center rounded-md text-[color:var(--loss)] hover:bg-[color:rgba(255,77,109,0.16)]"
        >
          <Trash2 size={14} />
        </button>
      </div>

      <div className="grid grid-cols-3 gap-3 p-3.5">
        <Field label="Date">
          {(id) => (
            <Input
              id={id}
              type="date"
              value={pool.slot.date}
              onChange={(e) => setSlot({ date: e.target.value })}
            />
          )}
        </Field>
        <Field label="Start">
          {(id) => (
            <Input
              id={id}
              type="time"
              className="font-mono"
              value={pool.slot.start}
              onChange={(e) => setSlot({ start: e.target.value })}
            />
          )}
        </Field>
        <Field label="End">
          {(id) => (
            <Input
              id={id}
              type="time"
              className="font-mono"
              value={pool.slot.end}
              onChange={(e) => setSlot({ end: e.target.value })}
            />
          )}
        </Field>
      </div>

      <div className="px-3.5 pb-3.5">
        <div className="mb-1.5 text-[11px] font-semibold tracking-[0.12em] text-[color:var(--fg-3)] uppercase">
          Tables in pool
        </div>
        <div className="flex flex-wrap gap-1.5">
          {tables.map((t) => {
            const selected = pool.tableIds.includes(t.id)
            return (
              <button
                key={t.id}
                type="button"
                aria-pressed={selected}
                aria-label={t.label}
                onClick={() => toggleTable(t.id)}
                className={cn(
                  'rounded-full border px-2.5 py-1 font-mono text-[12px] transition-colors',
                  selected
                    ? 'border-[color:rgba(255,122,26,0.3)] bg-[color:var(--bg-accent-soft)] text-[color:var(--ball-500)]'
                    : 'border-[color:var(--border-subtle)] text-[color:var(--fg-2)] hover:bg-[color:var(--bg-hover)]',
                )}
              >
                {t.label}
              </button>
            )
          })}
        </div>
      </div>
    </Card>
  )
}
