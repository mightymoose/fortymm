import { useId } from 'react'
import { Trash2 } from 'lucide-react'

import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'

import { fmtDate } from '../../../data/helpers'
import type { PoolDraft, TournamentTable } from '../../../data/types'
import { Field } from '../../../field'
import { ReadOnlyValue } from '../../../read-only-value'

/**
 * Whether this pool may be **removed from the event** — and if not, where the reason is
 * written.
 *
 * A pool cannot leave an event whose draw is cut: its fixtures name it, and they would be
 * left pointing at nothing (ADR-0786; the server 409s it). The card does not carry the
 * *words* for that — one explanation for the whole section, said once, lives above the
 * cards in `PoolsSection` — so what it carries instead is the **id of that explanation**,
 * which the disabled button points its `aria-describedby` at. A screen reader landing on
 * the dead control is told the same sentence a sighted director reads above it.
 *
 * A sum type, and not a `canRemove: boolean` + an optional id, because "frozen but with
 * nothing to point at" is precisely the unexplained dead end (ADR-0015) — and this makes
 * it unconstructible.
 */
export type PoolRemoval =
  | { kind: 'allowed' }
  | { kind: 'frozen'; reasonId: string }

export interface PoolCardProps {
  /** The three fields this card can edit — a `PoolDraft`, never a whole `Pool`
   * (`data/types`). The identity is deliberately out of reach: an id is the server's to
   * mint (ADR 20260801) and a `position` is the server's to assign, so a card that could
   * not see either is a card that cannot author either. Its owner re-attaches the entry's
   * arm around what comes back through `onChange`. */
  pool: PoolDraft
  /** The tables available to this tournament. */
  tables: TournamentTable[]
  /** The event's IANA timezone (ADR 20260719) — the frame this pool's wall-clock
   * window is in, rendered as a caption beside it. A pool carries no zone of its
   * own; the event owns it, so the section hands it down. */
  timezone: string
  /** When false (a non-creator), the card renders the pool as text — its name,
   * its window, and the tables it reserves — instead of a name box, three
   * date/time fields and a wall of table toggles (ADR 0015). */
  canEdit: boolean
  /** Whether this pool may be removed (see `PoolRemoval`). It gates the trash button
   * and **nothing else**: with the draw cut, the name box, the window and the table
   * chips are all still live, because a pool's venue attributes were never frozen and
   * a table that breaks mid-event has to be recorded without destroying the draw. */
  removal: PoolRemoval
  /** What is wrong with this pool's **name**, in the organizer's words, or `undefined`
   * when nothing is — the resolver's verdict on this row (`poolNameSchema`), handed
   * down by `PoolsSection` and rendered under the box.
   *
   * It is a `string | undefined` rather than a `boolean` + a table of copy here,
   * because the sentence is the schema's: one rule, one wording, said wherever it is
   * shown. A viewer never sees it — a read-only card has no box to clear. */
  nameError?: string
  onChange: (pool: PoolDraft) => void
  onRemove: () => void
}

/** The card's chrome, shared by both renderings so the two cannot drift apart
 * (ADR 0015, rule 3: the read-only view mirrors the editor's layout).
 *
 * The header is split in two because only the *editor's* header can grow a second line
 * — the red under the name box. So the rule below the header belongs to the **block**,
 * not to the row: hang the border off the row and a validation message renders *below*
 * the divider, in the window's whitespace, reading as though it were about the date.
 * The read-only branch, which has neither box nor message, composes the two back into
 * the one row it has always been. */
const HEADER_ROW_INNER = 'flex items-center gap-2.5 p-3.5'
const HEADER_BORDER = 'border-b border-[color:var(--border-subtle)]'
const HEADER_ROW = cn(HEADER_ROW_INNER, HEADER_BORDER)
const OVERLINE =
  'mb-1.5 text-[11px] font-semibold tracking-[0.12em] text-[color:var(--fg-3)] uppercase'
const WINDOW_WRAP = 'flex flex-col gap-2 p-3.5'
const WINDOW_GRID = 'grid grid-cols-3 gap-3'

/** The frame this pool's window is in (ADR 20260719): the event's timezone, shown
 * beside every pool window so the wall-clock times below are never read in a vacuum.
 * The event owns the zone — a pool does not carry its own — so it is handed down. A
 * plain caption, not a control: a reader sees it as readily as an editor. */
const PoolWindowTimezone = ({ timezone }: { timezone: string }) => (
  <span
    data-testid="pool-timezone-label"
    className="font-mono text-[10px] tracking-wide text-[color:var(--fg-3)]"
  >
    {timezone}
  </span>
)

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
const reservedTableLabels = (
  pool: PoolDraft,
  tables: TournamentTable[],
): string =>
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
  timezone,
  canEdit,
  removal,
  nameError,
  onChange,
  onRemove,
}: PoolCardProps) => {
  // The id of the red message, so the *box* points at it (`aria-describedby`). A `<p>`
  // that merely sits below an input is next to it on screen and nowhere at all to a
  // screen reader.
  const nameErrorId = useId()

  /** Hand back the three fields this card owns, with one of them changed — rebuilt by
   * name rather than spread from `pool`, so nothing the *caller* happened to pass in
   * (the arm and id of a `PoolEntry`, say) can make the return trip through here. The
   * card edits a pool's words; who that pool is stays with the section. */
  const change = (patch: Partial<PoolDraft>) =>
    onChange({
      name: pool.name,
      slot: pool.slot,
      tableIds: pool.tableIds,
      ...patch,
    })

  const setSlot = (patch: Partial<PoolDraft['slot']>) =>
    change({ slot: { ...pool.slot, ...patch } })

  const toggleTable = (id: string) =>
    change({
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
        <div className={WINDOW_WRAP}>
          <PoolWindowTimezone timezone={timezone} />
          <div className={WINDOW_GRID}>
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
      <div className={HEADER_BORDER}>
        <div className={HEADER_ROW_INNER}>
          <Input
            aria-label="Pool name"
            value={pool.name}
            onChange={(e) => change({ name: e.target.value })}
            aria-invalid={!!nameError}
            aria-describedby={nameError ? nameErrorId : undefined}
            className={cn(
              'h-8 flex-1 border-transparent bg-transparent text-[15px] font-semibold shadow-none focus-visible:border-[color:var(--border-default)]',
              // The box is *chromeless* until it is wrong: a transparent border is the
              // whole look of this header. So the red border has to be said out loud
              // here — `aria-invalid` alone styles nothing a transparent border shows.
              nameError &&
                'border-[color:var(--loss)] focus-visible:border-[color:var(--loss)]',
            )}
          />
          <TableCount count={pool.tableIds.length} />
          {/* Disabled — not hidden — while the draw is cut, and pointed at the section's
              one explanation of why (ADR-0786). Hiding it would take the way out with it:
              this button is one deleted draw away from working, which is exactly what
              distinguishes this case from the viewer's (whose controls are absent, because
              nothing they could do would bring them back). The accessible name stays
              "Remove pool" — the name of a control is what it *does*, not what state it is
              in; the state is `disabled` and the reason is the description. */}
          <button
            type="button"
            aria-label="Remove pool"
            disabled={removal.kind === 'frozen'}
            aria-describedby={
              removal.kind === 'frozen' ? removal.reasonId : undefined
            }
            onClick={onRemove}
            className="grid size-7 place-items-center rounded-md text-[color:var(--loss)] hover:bg-[color:rgba(255,77,109,0.16)] disabled:cursor-not-allowed disabled:text-[color:var(--fg-3)] disabled:opacity-50 disabled:hover:bg-transparent"
          >
            <Trash2 size={14} />
          </button>
        </div>

        {/* The refusal, under the box it is about and above the divider — the shape every
            other field in this editor uses (`Field`'s error hint, `CLAUDE.md` `## Forms`):
            inline, in red, never a toast and never a banner. A blank pool name is a 422
            the server now states (`min_length=1`), and this is what means it is never
            *reached*: the save is refused in the form, so nothing is sent and Pydantic's
            prose has nothing to arrive in. */}
        {nameError && (
          <p
            id={nameErrorId}
            data-testid="pool-name-error"
            className="-mt-2 px-3.5 pb-3 text-xs text-[color:var(--loss)]"
          >
            {nameError}
          </p>
        )}
      </div>

      <div className={WINDOW_WRAP}>
        <PoolWindowTimezone timezone={timezone} />
        <div className={WINDOW_GRID}>
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
