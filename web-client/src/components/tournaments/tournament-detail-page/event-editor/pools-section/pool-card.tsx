import { Trash2 } from 'lucide-react'

import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'

import { fmtDate } from '../../../data/helpers'
import type { Pool, TournamentTable } from '../../../data/types'
import { Field } from '../../../field'
import { ReadOnlyValue } from '../../../read-only-value'

export interface PoolCardProps {
  pool: Pool
  /** The tables available to this tournament. */
  tables: TournamentTable[]
  /** When false (a non-creator), the card renders the pool as text — its name,
   * its window, and the tables it reserves — instead of a name box, three
   * date/time fields and a wall of table toggles (ADR 0015). */
  canEdit: boolean
  onChange: (pool: Pool) => void
  onRemove: () => void
}

/** The card's chrome, shared by both renderings so the two cannot drift apart
 * (ADR 0015, rule 3: the read-only view mirrors the editor's layout). */
const HEADER_ROW =
  'flex items-center gap-2.5 border-b border-[color:var(--border-subtle)] p-3.5'
const OVERLINE =
  'mb-1.5 text-[11px] font-semibold tracking-[0.12em] text-[color:var(--fg-3)] uppercase'
const WINDOW_ROW = 'grid grid-cols-3 gap-3 p-3.5'

/** How many tables the pool holds — a fact about the pool, so a viewer reads it
 * too. */
const TableCount = ({ count }: { count: number }) => (
  <span className="rounded-full bg-[color:var(--bg-raised)] px-2 py-0.5 font-mono text-[11px] text-[color:var(--fg-2)]">
    {count} {count === 1 ? 'table' : 'tables'}
  </span>
)

/** The reserved tables as one line — the same labels the toggles show ("T1, T2,
 * T5"), so there is no second vocabulary to keep in step. Driven off the table
 * catalogue rather than off `pool.tableIds`, so the list reads in catalogue
 * order and an id with no table behind it simply isn't named.
 *
 * An empty string is what `ReadOnlyValue` treats as unset — a pool that reserves
 * nothing renders as an em-dash, not as a blank. */
const reservedTableLabels = (pool: Pool, tables: TournamentTable[]): string =>
  tables
    .filter((t) => pool.tableIds.includes(t.id))
    .map((t) => t.label)
    .join(', ')

/** A single table pool. For the creator: a name box, a date/start/end window,
 * and a multi-select of the tournament's tables (rendered as toggle chips). For
 * a viewer: the same pool read back as text — its name, its window, and the
 * tables it reserves — with no control to reach for (ADR 0015). */
export const PoolCard = ({
  pool,
  tables,
  canEdit,
  onChange,
  onRemove,
}: PoolCardProps) => {
  const setSlot = (patch: Partial<Pool['slot']>) =>
    onChange({ ...pool, slot: { ...pool.slot, ...patch } })

  const toggleTable = (id: string) =>
    onChange({
      ...pool,
      tableIds: pool.tableIds.includes(id)
        ? pool.tableIds.filter((x) => x !== id)
        : [...pool.tableIds, id],
    })

  if (!canEdit) {
    return (
      <Card className="gap-0 p-0" data-testid="pool-card">
        <div className={HEADER_ROW}>
          <div data-testid="pool-name" className="min-w-0 flex-1">
            <ReadOnlyValue className="h-8 text-[15px] font-semibold">
              {pool.name}
            </ReadOnlyValue>
          </div>
          <TableCount count={pool.tableIds.length} />
        </div>

        {/* `readOnly` on each row is what renders the value instead of a control
            and keeps the form's furniture out of the view: these rows carry no
            hint or asterisk today, but a `Field` that grows one must not leak it
            here (ADR 0015). The date reads in words — the wire format is the
            editor's `<input type="date">` value, not a reader's. */}
        <div className={WINDOW_ROW}>
          <Field label="Date" readOnly value={fmtDate(pool.slot.date)} />
          <Field
            label="Start"
            readOnly
            value={pool.slot.start}
            valueClassName="font-mono"
          />
          <Field
            label="End"
            readOnly
            value={pool.slot.end}
            valueClassName="font-mono"
          />
        </div>

        <div className="px-3.5 pb-3.5">
          <div className={OVERLINE}>Tables in pool</div>
          <div data-testid="pool-tables">
            <ReadOnlyValue className="h-auto min-h-8 font-mono">
              {reservedTableLabels(pool, tables)}
            </ReadOnlyValue>
          </div>
        </div>
      </Card>
    )
  }

  return (
    <Card className="gap-0 p-0" data-testid="pool-card">
      <div className={HEADER_ROW}>
        <Input
          aria-label="Pool name"
          value={pool.name}
          onChange={(e) => onChange({ ...pool, name: e.target.value })}
          className="h-8 flex-1 border-transparent bg-transparent text-[15px] font-semibold shadow-none focus-visible:border-[color:var(--border-default)]"
        />
        <TableCount count={pool.tableIds.length} />
        <button
          type="button"
          aria-label="Remove pool"
          onClick={onRemove}
          className="grid size-7 place-items-center rounded-md text-[color:var(--loss)] hover:bg-[color:rgba(255,77,109,0.16)]"
        >
          <Trash2 size={14} />
        </button>
      </div>

      <div className={WINDOW_ROW}>
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
        <div className={OVERLINE}>Tables in pool</div>
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
