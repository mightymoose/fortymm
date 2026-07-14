import { CalendarClock, MapPin, Pencil, Plus } from 'lucide-react'
import { useState } from 'react'

import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'

import { usePlaceFixture } from '../data/api'
import type { FixtureSide } from '../data/draw'
import { EM_DASH, fmtDateShort, fmtTimeWindow } from '../data/helpers'
import {
  buildSchedule,
  composeScheduledStart,
  matchLabel,
  scheduleStatusLabel,
  timeOfDay,
  type ScheduleMatch,
  type ScheduleTable,
} from '../data/schedule'
import type { Tournament, TournamentTable } from '../data/types'
import { EmptyState } from '../empty-state'
import { OptionSelect } from './event-editor/option-select'
import { SectionHeader } from './section-header'

/** The body the placement PATCH takes — the placement whole, `null` to clear. */
type PlacementBody = { table_id: string | null; scheduled_start: string | null }

export interface ScheduleTabProps {
  tournament: Tournament
  /** The tournament's table catalogue (labels + courts), resolving a placement's
   * `tableId` to a table. Passed alongside the tournament because the domain
   * `Tournament` carries only table *ids* — the labels live on the catalogue. */
  tables: TournamentTable[]
}

/** One side of the `A vs B` pairing — the entrant's username, or the same `TBD` /
 * `Withdrawn` words the draw uses (a side is never a blank or a raw id). */
const Side = ({ side }: { side: FixtureSide }) => {
  switch (side.kind) {
    case 'entrant':
      return <span className="text-[color:var(--fg-1)]">{side.name}</span>
    case 'tbd':
      return <span className="text-[color:var(--fg-3)] italic">TBD</span>
    case 'withdrawn':
      return <span className="text-[color:var(--warn)]">Withdrawn</span>
    default: {
      const exhaustive: never = side
      return exhaustive
    }
  }
}

/** The director's placement editor for one match (owner only): pick a **table** (the
 * pool's own tables are marked as the natural suggestion) and a **time** within the
 * fixture's window, then Save — or Clear an existing placement.
 *
 * Only the **time** is asked: the placement's date is fixed by the pool/event Slot
 * (ADR-0790), so the naive timestamp is composed from that date + this time
 * (`composeScheduledStart`) — no `Date`, no timezone. The control is a plain
 * reveal-on-click panel, not a portal'd popover, so what a director (and a test) sees is
 * the DOM, in place. */
const PlacementControl = ({
  match,
  tables,
  onSubmit,
  isPending,
}: {
  match: ScheduleMatch
  tables: TournamentTable[]
  onSubmit: (body: PlacementBody) => Promise<void>
  isPending: boolean
}) => {
  const placed = match.tableId !== null
  const [editing, setEditing] = useState(false)
  const [tableId, setTableId] = useState(
    () => match.tableId ?? match.suggestedTableIds[0] ?? tables[0]?.id ?? '',
  )
  const [time, setTime] = useState(
    () => timeOfDay(match.scheduledStart) || match.window.start,
  )

  const options = tables.map((t) => ({
    value: t.id,
    label: match.suggestedTableIds.includes(t.id) ? `${t.label} · pool table` : t.label,
  }))
  // A placement can name a table the catalogue no longer lists (a dangling ref, ADR-0790):
  // keep it selectable so the editor can *see* what it is on before moving off it, rather
  // than silently showing an empty trigger.
  if (match.tableId !== null && !tables.some((t) => t.id === match.tableId)) {
    options.unshift({ value: match.tableId, label: `${match.tableId} · removed` })
  }

  const label = matchLabel(match)

  const submit = async () => {
    try {
      await onSubmit({
        table_id: tableId,
        scheduled_start: composeScheduledStart(match.window.date, time),
      })
      setEditing(false)
    } catch {
      // The mutation toasts its own failure; keep the panel open so the work survives.
    }
  }
  const clear = async () => {
    try {
      await onSubmit({ table_id: null, scheduled_start: null })
      setEditing(false)
    } catch {
      // As above.
    }
  }

  if (!editing) {
    return (
      <Button
        size="sm"
        variant={placed ? 'ghost' : 'outline'}
        data-testid={`place-trigger-${match.fixtureId}`}
        aria-label={`${placed ? 'Edit placement for' : 'Place'} ${match.eventName} — ${label}`}
        onClick={() => setEditing(true)}
      >
        {placed ? <Pencil size={14} /> : <Plus size={14} />}
        {placed ? 'Move' : 'Place'}
      </Button>
    )
  }

  return (
    <div
      data-testid={`place-editor-${match.fixtureId}`}
      className="mt-1.5 flex flex-wrap items-end gap-2"
    >
      <OptionSelect
        value={tableId}
        options={options}
        onChange={setTableId}
        ariaLabel={`Table for ${label}`}
        className="w-44"
      />
      <Input
        type="time"
        value={time}
        onChange={(e) => setTime(e.target.value)}
        aria-label={`Predicted start for ${label}`}
        data-testid={`place-time-${match.fixtureId}`}
        className="w-32"
      />
      <Button
        size="sm"
        data-testid={`place-save-${match.fixtureId}`}
        disabled={isPending}
        onClick={submit}
      >
        Save
      </Button>
      {placed && (
        <Button
          size="sm"
          variant="ghost"
          data-testid={`place-clear-${match.fixtureId}`}
          disabled={isPending}
          onClick={clear}
        >
          Clear
        </Button>
      )}
      <Button
        size="sm"
        variant="ghost"
        data-testid={`place-cancel-${match.fixtureId}`}
        disabled={isPending}
        onClick={() => setEditing(false)}
      >
        Cancel
      </Button>
    </div>
  )
}

/** One match on the schedule: its pairing, its status, its predicted time (in a table
 * column) and — for the owner — the placement control. Rendered inside a table column or
 * the awaiting-placement group; `showTime` is on in a column, where the time is the fact
 * that orders the rows, and off in awaiting, where there is none. */
const MatchRow = ({
  match,
  tables,
  canEdit,
  onSubmit,
  isPending,
  showTime,
}: {
  match: ScheduleMatch
  tables: TournamentTable[]
  canEdit: boolean
  onSubmit: (fixtureId: string, body: PlacementBody) => Promise<void>
  isPending: boolean
  showTime: boolean
}) => {
  const time = timeOfDay(match.scheduledStart)
  return (
    <div
      data-testid={`schedule-match-${match.fixtureId}`}
      className="flex flex-col gap-1 border-t border-[color:var(--border-subtle)] px-4 py-2.5 first:border-t-0"
    >
      <div className="flex flex-wrap items-baseline gap-x-2 text-[13px]">
        {showTime && (
          <span className="font-mono text-[12px] tabular-nums text-[color:var(--ball-500)]">
            {time || EM_DASH}
          </span>
        )}
        <span className="flex items-baseline gap-x-1.5">
          <Side side={match.a} />{' '}
          <span className="text-[color:var(--fg-3)]">vs</span>{' '}
          <Side side={match.b} />
        </span>
        <span className="text-[11px] text-[color:var(--fg-3)]">
          · {match.eventName}
        </span>
        <span
          data-testid={`schedule-status-${match.fixtureId}`}
          className="ml-auto text-[11px] font-medium text-[color:var(--fg-3)]"
        >
          {scheduleStatusLabel(match.match)}
        </span>
      </div>
      {/* The control, for the director alone. A finished match (`!placeable`) is frozen
          server-side, so it gets no control — not a disabled one (ADR-0015). A non-owner
          gets none either way. */}
      {canEdit && match.placeable && (
        <PlacementControl
          match={match}
          tables={tables}
          isPending={isPending}
          onSubmit={(body) => onSubmit(match.fixtureId, body)}
        />
      )}
    </div>
  )
}

/** The reserved pool windows — real, director-entered data (ADR-0790), kept visible as
 * lightweight context beneath the real matches: which pools reserve which tables, when.
 * Not the schedule itself (that is the matches above); an *input* to it. */
const ReservedWindows = ({ tournament }: { tournament: Tournament }) => {
  const rows = tournament.events.flatMap((event) =>
    event.pools.map((pool) => ({
      key: `${event.id}-${pool.id}`,
      event: event.name,
      pool: pool.name,
      date: pool.slot.date,
      window: fmtTimeWindow(pool.slot.start, pool.slot.end),
      tables: pool.tableIds.length,
    })),
  )
  if (rows.length === 0) return null
  return (
    <section data-testid="schedule-windows" className="mt-6">
      <h3 className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold tracking-[0.12em] text-[color:var(--fg-3)] uppercase">
        <MapPin size={13} />
        Reserved windows
      </h3>
      <Card className="gap-0 p-0">
        {rows.map((row) => (
          <div
            key={row.key}
            className="flex flex-wrap items-baseline gap-x-2 border-t border-[color:var(--border-subtle)] px-4 py-2 text-[12px] first:border-t-0"
          >
            <span className="font-semibold text-[color:var(--fg-1)]">{row.event}</span>
            <span className="text-[color:var(--fg-3)]">·</span>
            <span className="text-[color:var(--fg-2)]">{row.pool}</span>
            <span className="ml-auto font-mono tabular-nums text-[color:var(--fg-3)]">
              {fmtDateShort(row.date)} · {row.window} · {row.tables}×
            </span>
          </div>
        ))}
      </Card>
    </section>
  )
}

/** One table's column: the table's label/court, then its matches in predicted-time
 * order. `table` is `null` for a placement on a table the catalogue no longer lists — it
 * is shown under its raw id, never dropped (ADR-0790). */
const TableColumn = ({
  column,
  tables,
  canEdit,
  onSubmit,
  isPending,
}: {
  column: ScheduleTable
  tables: TournamentTable[]
  canEdit: boolean
  onSubmit: (fixtureId: string, body: PlacementBody) => Promise<void>
  isPending: boolean
}) => (
  <section data-testid={`schedule-table-${column.tableId}`}>
    <div className="mb-2 flex items-baseline gap-2">
      <div className="font-display text-[20px] tracking-[0.02em] text-[color:var(--fg-1)]">
        {column.table ? column.table.label : column.tableId}
      </div>
      {column.table ? (
        <span className="text-[11px] text-[color:var(--fg-3)]">
          Court {column.table.court}
        </span>
      ) : (
        <span className="text-[11px] text-[color:var(--warn)]">
          Removed from the catalogue
        </span>
      )}
    </div>
    <Card className="gap-0 p-0">
      {column.matches.map((match) => (
        <MatchRow
          key={match.fixtureId}
          match={match}
          tables={tables}
          canEdit={canEdit}
          onSubmit={onSubmit}
          isPending={isPending}
          showTime
        />
      ))}
    </Card>
  </section>
)

/**
 * The Schedule tab: the tournament's **real matches**, organized by the venue (ADR-0790).
 *
 * It is **tournament-scoped**, not per-event — the tables are shared across events, so a
 * same-table clash is a cross-event fact — so it reduces every event's fixtures into one
 * view: grouped by **table** (a table's matches in predicted-time order), with a distinct
 * **awaiting-placement** group for the matches no table/time has been chosen for yet. A
 * freshly-live tournament shows every match in that group, not an empty grid.
 *
 * The **placement control** is the director's alone (`canEdit`): pick a table and a time,
 * and the placement re-renders from the server — the mutation invalidates the tournament
 * detail query, so `tournament` arrives again with the new table/time and this recomputes
 * (`buildSchedule`). A non-owner sees the same schedule with no control (ADR-0015: hidden,
 * never disabled). Conflict flagging (double-booked tables/players) is a later scheduler
 * slice and deliberately absent here — placement is soft (ADR-0790).
 */
export const ScheduleTab = ({ tournament, tables }: ScheduleTabProps) => {
  const canEdit = tournament.canEdit
  const place = usePlaceFixture(tournament.id)
  const schedule = buildSchedule(tournament, tables)

  const onSubmit = (fixtureId: string, body: PlacementBody) =>
    place.mutateAsync({ fixtureId, body }).then(() => undefined)

  return (
    <div data-testid="schedule-tab">
      <SectionHeader
        title="Schedule"
        subtitle={
          canEdit
            ? 'Every match, by table. Place a match on a table and a predicted time — the date comes from its pool window.'
            : 'Every match, by table, with its predicted start time.'
        }
      />

      {schedule.isEmpty ? (
        <EmptyState
          icon={<CalendarClock size={28} />}
          title="Nothing to schedule yet"
          hint="Cut a draw for an event to see its matches here."
        />
      ) : (
        <div className="flex flex-col gap-6">
          {schedule.tables.map((column) => (
            <TableColumn
              key={column.tableId}
              column={column}
              tables={tables}
              canEdit={canEdit}
              onSubmit={onSubmit}
              isPending={place.isPending}
            />
          ))}

          {schedule.awaiting.length > 0 && (
            <section data-testid="schedule-awaiting">
              <div className="mb-2 flex items-baseline gap-2">
                <div className="font-display text-[20px] tracking-[0.02em] text-[color:var(--fg-1)]">
                  Awaiting placement
                </div>
                <span className="rounded-full bg-[color:var(--bg-raised)] px-2 py-0.5 font-mono text-[11px] text-[color:var(--fg-2)]">
                  {schedule.awaiting.length}
                </span>
              </div>
              <Card className="gap-0 p-0">
                {schedule.awaiting.map((match) => (
                  <MatchRow
                    key={match.fixtureId}
                    match={match}
                    tables={tables}
                    canEdit={canEdit}
                    onSubmit={onSubmit}
                    isPending={place.isPending}
                    showTime={false}
                  />
                ))}
              </Card>
            </section>
          )}

          <ReservedWindows tournament={tournament} />
        </div>
      )}
    </div>
  )
}
