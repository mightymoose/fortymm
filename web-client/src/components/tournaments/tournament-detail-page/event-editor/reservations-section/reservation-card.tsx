import { useId } from 'react'
import { Trash2 } from 'lucide-react'

import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'

import { fmtDate } from '../../../data/helpers'
import type { ReservationDraft, TournamentTable } from '../../../data/types'
import { Field } from '../../../field'
import { ReadOnlyValue } from '../../../read-only-value'

/**
 * Whether this reservation may be **removed from the event** — and if not, where the reason is
 * written.
 *
 * A reservation cannot leave an event whose draw is cut: its fixtures name it, and they would be
 * left pointing at nothing (ADR-0786; the server 409s it). The card does not carry the
 * *words* for that — one explanation for the whole section, said once, lives above the
 * cards in `ReservationsSection` — so what it carries instead is the **id of that explanation**,
 * which the disabled button points its `aria-describedby` at. A screen reader landing on
 * the dead control is told the same sentence a sighted director reads above it.
 *
 * A sum type, and not a `canRemove: boolean` + an optional id, because "frozen but with
 * nothing to point at" is precisely the unexplained dead end (ADR-0015) — and this makes
 * it unconstructible.
 */
export type ReservationRemoval =
  | { kind: 'allowed' }
  | { kind: 'frozen'; reasonId: string }

export interface ReservationCardProps {
  /** The three fields this card can edit — a `ReservationDraft`, never a whole `Reservation`
   * (`data/types`). The identity is deliberately out of reach: an id is the server's to
   * mint (ADR 20260801) and a `position` is the server's to assign, so a card that could
   * not see either is a card that cannot author either — what it hands back through
   * `onChange` is the draft, and its owner re-attaches the entry's arm around that.
   * (#1441 hands the card its **rendered** position separately, below; it names the
   * Remove control and the draft never carries it.) */
  reservation: ReservationDraft
  /** The tables available to this tournament. */
  tables: TournamentTable[]
  /** The event's IANA timezone (ADR 20260719) — the frame this reservation's wall-clock
   * window is in, rendered as a caption beside it. A reservation carries no zone of its
   * own; the event owns it, so the section hands it down. */
  timezone: string
  /** When false (a non-creator), the card renders the reservation as text — its name,
   * its window, and the tables it reserves — instead of a name box, three
   * date/time fields and a wall of table toggles (ADR 0015). */
  canEdit: boolean
  /** This card's 1-based position in the **rendered** list — the section's field-array
   * order as it stands right now, recomputed on every render and never the entry's
   * server-managed `position`. #1441 pairs it with the live name in the Remove
   * control's accessible name (`Remove reservation 2: Reservation B`) because names
   * are editable, can be briefly blank, and can be duplicated while #1046 is open —
   * the position is the part that stays distinct when the name cannot. */
  position: number
  /** Whether this reservation may be removed (see `ReservationRemoval`). It gates the trash button
   * and **nothing else**: with the draw cut, the name box, the window and the table
   * chips are all still live, because a reservation's venue attributes were never frozen and
   * a table that breaks mid-event has to be recorded without destroying the draw. */
  removal: ReservationRemoval
  /** What is wrong with this reservation's **name**, in the organizer's words, or `undefined`
   * when nothing is — the resolver's verdict on this row (`reservationNameSchema`), handed
   * down by `ReservationsSection` and rendered under the box.
   *
   * It is a `string | undefined` rather than a `boolean` + a table of copy here,
   * because the sentence is the schema's: one rule, one wording, said wherever it is
   * shown. A viewer never sees it — a read-only card has no box to clear. */
  nameError?: string
  /** What is wrong with this reservation's **window**, in the organizer's words, or
   * `undefined` when nothing is — #1501's ordering and containment rules
   * (`reservationWindowIssues`, `../event-form`), handed down the same way `nameError`
   * is and rendered the same way: under the window it is about, in red, wired so a
   * screen reader hears it too. A viewer never sees it, for the same reason it never
   * sees `nameError` — a read-only card has no box to fix. */
  windowError?: string
  onChange: (reservation: ReservationDraft) => void
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

/** The frame this reservation's window is in (ADR 20260719): the event's timezone, shown
 * beside every reservation window so the wall-clock times below are never read in a vacuum.
 * The event owns the zone — a reservation does not carry its own — so it is handed down. A
 * plain caption, not a control: a reader sees it as readily as an editor. */
const ReservationWindowTimezone = ({ timezone }: { timezone: string }) => (
  <span
    data-testid="reservation-timezone-label"
    className="font-mono text-[10px] tracking-wide text-[color:var(--fg-3)]"
  >
    {timezone}
  </span>
)

/** How many tables the reservation holds — a fact about the reservation, so a viewer reads it
 * too. */
const TableCount = ({ count }: { count: number }) => (
  <span className="rounded-full bg-[color:var(--bg-raised)] px-2 py-0.5 font-mono text-[11px] text-[color:var(--fg-2)]">
    {count} {count === 1 ? 'table' : 'tables'}
  </span>
)

/** The reserved tables as one line — the same labels the toggles show ("T1, T2,
 * T5"), so there is no second vocabulary to keep in step. Driven off the table
 * catalogue rather than off `reservation.tableIds`, so the list reads in catalogue
 * order and an id with no table behind it simply isn't named.
 *
 * An empty string is what `ReadOnlyValue` treats as unset — a reservation that reserves
 * nothing renders as an em-dash, not as a blank. */
const reservedTableLabels = (
  reservation: ReservationDraft,
  tables: TournamentTable[],
): string =>
  tables
    .filter((t) => reservation.tableIds.includes(t.id))
    .map((t) => t.label)
    .join(', ')

/** A single table reservation. For the creator: a name box, a date/start/end window,
 * and a multi-select of the tournament's tables (rendered as toggle chips). For
 * a viewer: the same reservation read back as text — its name, its window, and the
 * tables it reserves — with no control to reach for (ADR 0015). */
export const ReservationCard = ({
  reservation,
  tables,
  timezone,
  canEdit,
  position,
  removal,
  nameError,
  windowError,
  onChange,
  onRemove,
}: ReservationCardProps) => {
  // The id of the red message, so the *box* points at it (`aria-describedby`). A `<p>`
  // that merely sits below an input is next to it on screen and nowhere at all to a
  // screen reader.
  const nameErrorId = useId()
  // …and the window's own message, the same treatment one row down (#1501).
  const windowErrorId = useId()

  /** Hand back the three fields this card owns, with one of them changed — rebuilt by
   * name rather than spread from `reservation`, so nothing the *caller* happened to pass in
   * (the arm and id of a `ReservationEntry`, say) can make the return trip through here. The
   * card edits a reservation's words; who that reservation is stays with the section. */
  const change = (patch: Partial<ReservationDraft>) =>
    onChange({
      name: reservation.name,
      slot: reservation.slot,
      tableIds: reservation.tableIds,
      ...patch,
    })

  const setSlot = (patch: Partial<ReservationDraft['slot']>) =>
    change({ slot: { ...reservation.slot, ...patch } })

  const toggleTable = (id: string) =>
    change({
      tableIds: reservation.tableIds.includes(id)
        ? reservation.tableIds.filter((x) => x !== id)
        : [...reservation.tableIds, id],
    })

  // The Remove control's accessible name (#1441) — the Tables tab's `Remove T1`
  // convention, carried one disambiguator further: the card's 1-based rendered
  // position, plus the LIVE name, so the name is the one on screen right now and
  // follows every keystroke before any save. A blank or whitespace-only name falls
  // back to the bare position, with no empty colon — and duplicated names stay
  // distinct, because the positions differ. Never the entry's id or its stored
  // position: this is about the card in front of the director, not the row on the
  // server.
  const removeAccessibleName = reservation.name.trim()
    ? `Remove reservation ${position}: ${reservation.name}`
    : `Remove reservation ${position}`

  if (!canEdit) {
    return (
      <Card className="gap-0 p-0" data-testid="reservation-card">
        <div className={HEADER_ROW}>
          <div data-testid="reservation-name" className="min-w-0 flex-1">
            <ReadOnlyValue className="h-8 text-[15px] font-semibold">
              {reservation.name}
            </ReadOnlyValue>
          </div>
          <TableCount count={reservation.tableIds.length} />
        </div>

        {/* `readOnly` on each row is what renders the value instead of a control
            and keeps the form's furniture out of the view: these rows carry no
            hint or asterisk today, but a `Field` that grows one must not leak it
            here (ADR 0015). The date reads in words — the wire format is the
            editor's `<input type="date">` value, not a reader's. */}
        <div className={WINDOW_WRAP}>
          <ReservationWindowTimezone timezone={timezone} />
          <div className={WINDOW_GRID}>
            <Field label="Date" readOnly value={fmtDate(reservation.slot.date)} />
            <Field
              label="Start"
              readOnly
              value={reservation.slot.start}
              valueClassName="font-mono"
            />
            <Field
              label="End"
              readOnly
              value={reservation.slot.end}
              valueClassName="font-mono"
            />
          </div>
        </div>

        <div className="px-3.5 pb-3.5">
          <div className={OVERLINE}>Tables in reservation</div>
          <div data-testid="reservation-tables">
            <ReadOnlyValue className="h-auto min-h-8 font-mono">
              {reservedTableLabels(reservation, tables)}
            </ReadOnlyValue>
          </div>
        </div>
      </Card>
    )
  }

  return (
    <Card className="gap-0 p-0" data-testid="reservation-card">
      <div className={HEADER_BORDER}>
        <div className={HEADER_ROW_INNER}>
          <Input
            aria-label="Reservation name"
            value={reservation.name}
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
          <TableCount count={reservation.tableIds.length} />
          {/* Disabled — not hidden — while the draw is cut, and pointed at the section's
              one explanation of why (ADR-0786). Hiding it would take the way out with it:
              this button is one deleted draw away from working, which is exactly what
              distinguishes this case from the viewer's (whose controls are absent, because
              nothing they could do would bring them back). The accessible name names the
              card it removes (#1441) and stays so while disabled: the state is `disabled`,
              the reason is the description, and the name still says what it would remove. */}
          <button
            type="button"
            aria-label={removeAccessibleName}
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
            inline, in red, never a toast and never a banner. A blank reservation name is a 422
            the server now states (`min_length=1`), and this is what means it is never
            *reached*: the save is refused in the form, so nothing is sent and Pydantic's
            prose has nothing to arrive in. */}
        {nameError && (
          <p
            id={nameErrorId}
            data-testid="reservation-name-error"
            className="-mt-2 px-3.5 pb-3 text-xs text-[color:var(--loss)]"
          >
            {nameError}
          </p>
        )}
      </div>

      <div className={WINDOW_WRAP}>
        <ReservationWindowTimezone timezone={timezone} />
        <div className={WINDOW_GRID}>
          <Field label="Date">
            {(id) => (
              <Input
                id={id}
                type="date"
                value={reservation.slot.date}
                aria-invalid={!!windowError}
                aria-describedby={windowError ? windowErrorId : undefined}
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
                value={reservation.slot.start}
                aria-invalid={!!windowError}
                aria-describedby={windowError ? windowErrorId : undefined}
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
                value={reservation.slot.end}
                aria-invalid={!!windowError}
                aria-describedby={windowError ? windowErrorId : undefined}
                onChange={(e) => setSlot({ end: e.target.value })}
              />
            )}
          </Field>
        </div>
        {/* The refusal, under the window it is about — #1501's ordering/containment
            rules, the same shape the name error uses above (`CLAUDE.md`, `## Forms`):
            inline, in red, never a toast and never a banner. */}
        {windowError && (
          <p
            id={windowErrorId}
            data-testid="reservation-window-error"
            className="text-xs text-[color:var(--loss)]"
          >
            {windowError}
          </p>
        )}
      </div>

      <div className="px-3.5 pb-3.5">
        <div className={OVERLINE}>Tables in reservation</div>
        <div className="flex flex-wrap gap-1.5">
          {tables.map((t) => {
            const selected = reservation.tableIds.includes(t.id)
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
