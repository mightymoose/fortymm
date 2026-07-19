import {
  CalendarClock,
  LayoutGrid,
  List,
  MapPin,
  Pencil,
  Pin,
  Plus,
  Users,
} from 'lucide-react'
import { useMemo, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'

import {
  usePlaceFixture,
  useRequestScheduleSolve,
  useSchedulePolling,
} from '../data/api'
import { type FixtureSide, TBD_LABEL, WITHDRAWN_LABEL } from '../data/draw'
import { EM_DASH, fmtDateShort, fmtTimeWindow } from '../data/helpers'
import {
  buildSchedule,
  composeScheduledStart,
  fmtFixtureTime,
  matchLabel,
  placementConsequence,
  scheduleStatusLabel,
  type ScheduleMatch,
  type ScheduleTable,
} from '../data/schedule'
import {
  buildTimelineBoard,
  calledAtLabel,
  fmtBoardClock,
  isDecided,
  isTold,
  notifiedLabel,
  parseLocalLabel,
} from '../data/timeline'
import type {
  FixtureTime,
  Tournament,
  TournamentStatus,
  TournamentTable,
} from '../data/types'

/** A placement's predicted start as the 24-hour `HH:MM` wall-clock the time picker and
 * the confirm dialog speak — read off the server's venue-local `localLabel` (ADR
 * "tournament times are timezone-aware instants": the client never re-derives a zone,
 * it reads the label the server already rendered). `null` for an unscheduled placement. */
const wallClock24 = (time: FixtureTime | null): string | null =>
  time === null ? null : fmtBoardClock(parseLocalLabel(time.localLabel))
import { EmptyState } from '../empty-state'
import {
  ConfirmCallDialog,
  type CallConsequence,
  type PlacementSummary,
} from './confirm-call-dialog'
import { OptionSelect } from './event-editor/option-select'
import { BoardEmpty } from './schedule-tab/board-empty'
import { GanttBoard } from './schedule-tab/gantt-board'
import { PlayerTimelineBoard } from './schedule-tab/player-timeline-board'
import { TierLegend } from './schedule-tab/tier-legend'
import { SectionHeader } from './section-header'
import { SolveStrip } from './solve-strip'

/** The body the placement PATCH takes — the placement whole, `null` to clear. */
type PlacementBody = { table_id: string | null; scheduled_start: string | null }

/** The tab's three readings of ONE schedule: the placement **list** (the
 * default — nothing regresses), the **Gantt** board (tables × time) and the
 * **player timeline** (entrants × time). View choice is component state, the
 * same mechanism the page's own tabs use (`TournamentDetailPage` holds `tab` in
 * `useState`) — this page encodes no view state in the URL, so the toggle
 * invents no new URL contract. */
type ScheduleView = 'list' | 'gantt' | 'players'

/** Radix hands `onValueChange` a plain string (and `''` for a re-click on the
 * active item); narrow it rather than cast it. */
const isScheduleView = (v: string): v is ScheduleView =>
  v === 'list' || v === 'gantt' || v === 'players'

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
      return <span className="text-[color:var(--fg-3)] italic">{TBD_LABEL}</span>
    case 'withdrawn':
      return <span className="text-[color:var(--warn)]">{WITHDRAWN_LABEL}</span>
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
  status,
  onSubmit,
  isPending,
}: {
  match: ScheduleMatch
  tables: TournamentTable[]
  /** The tournament's lifecycle status — while `live`, a placement NOTIFIES
   * (ADR "the schedule is solved; the call is pinned"), so the submit path is
   * gated by a consequence-stating confirm. */
  status: TournamentStatus
  onSubmit: (body: PlacementBody) => Promise<void>
  isPending: boolean
}) => {
  const placed = match.tableId !== null
  const [editing, setEditing] = useState(false)
  const [tableId, setTableId] = useState(
    () => match.tableId ?? match.suggestedTableIds[0] ?? tables[0]?.id ?? '',
  )
  const [time, setTime] = useState(
    () => wallClock24(match.scheduledStart) ?? match.window.start,
  )
  /** The write held at the confirm gate — the body to send iff the director
   * confirms, with the consequence the dialog states. `null` = no dialog. */
  const [pending, setPending] = useState<{
    body: PlacementBody
    consequence: CallConsequence
  } | null>(null)

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

  // The mutation toasts its own failure; on error keep the panel open so the work survives.
  const run = async (body: PlacementBody) => {
    try {
      await onSubmit(body)
      setEditing(false)
    } catch {
      /* keep the panel open */
    }
  }

  /** A placement as the dialog would name it — the catalogue label (or the raw id of
   * a dangling ref, shown never blanked) and the `HH:MM` wall-clock. */
  const summarize = (
    id: string | null,
    wallClock: string | null,
  ): PlacementSummary => ({
    tableLabel:
      id === null ? '' : (tables.find((t) => t.id === id)?.label ?? id),
    time: wallClock,
  })

  /**
   * The gate on the submit path (ADR "the schedule is solved; the call is pinned"):
   * a write that would NOTIFY is priced before it is sent — held in `pending` behind
   * a consequence-stating confirm — and a silent one (pre-live, or clearing an
   * untold fixture) goes straight through, exactly as before.
   */
  const request = (body: PlacementBody) => {
    const kind = placementConsequence({
      tournamentStatus: status,
      match,
      write: { tableId: body.table_id, scheduledStart: body.scheduled_start },
    })
    if (kind === 'silent') {
      void run(body)
      return
    }
    const told = summarize(match.tableId, wallClock24(match.scheduledStart))
    // The write's time is the wall-clock the director just picked (`time`), unless the
    // write clears the placement (`scheduled_start: null`).
    const to = summarize(
      body.table_id,
      body.scheduled_start === null ? null : time,
    )
    const consequence: CallConsequence =
      kind === 'call'
        ? { variant: 'call', to }
        : kind === 'correction-move'
          ? {
              variant: 'correction-move',
              told,
              to,
              notifiedCount: match.callNotifiedCount,
            }
          : {
              variant: 'correction-cancel',
              told,
              notifiedCount: match.callNotifiedCount,
            }
    setPending({ body, consequence })
  }

  const submit = () =>
    request({
      table_id: tableId,
      // A placement's time is a *prediction*: an empty time is a valid table-only
      // placement (`scheduled_start: null`, ADR-0790), not a reason to compose a
      // malformed `YYYY-MM-DDT:00` the server would reject and swallow (leaving Save a
      // silent no-op). Only compose when there is a time to compose.
      scheduled_start: time ? composeScheduledStart(match.window.date, time) : null,
    })
  const clear = () => request({ table_id: null, scheduled_start: null })

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
      {/* The confirm on a NOTIFYING write. Confirm releases the held body to the
          same mutation the silent path uses; Go back (or Escape / the overlay)
          drops it — nothing is sent, the editor keeps the work. The refetched
          tournament brings pinned_at / call_notified_count back from the server;
          nothing here guesses the new count. */}
      {pending && (
        <ConfirmCallDialog
          open
          matchLabel={label}
          consequence={pending.consequence}
          onConfirm={() => {
            const { body } = pending
            setPending(null)
            void run(body)
          }}
          onCancel={() => setPending(null)}
        />
      )}
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
  status,
  canEdit,
  onSubmit,
  isPending,
  showTime,
}: {
  match: ScheduleMatch
  tables: TournamentTable[]
  status: TournamentStatus
  canEdit: boolean
  onSubmit: (fixtureId: string, body: PlacementBody) => Promise<void>
  isPending: boolean
  showTime: boolean
}) => {
  // The predicted start in the server's own venue-local words (`fmtFixtureTime` →
  // `"9:00 AM CDT"`, ADR "tournament times are timezone-aware instants"): the client
  // shows the label and its timezone verbatim, it never slices a datetime or picks a
  // zone. `''` when the fixture has no predicted time yet.
  const time = match.scheduledStart ? fmtFixtureTime(match.scheduledStart) : ''
  // The list speaks the boards' tier vocabulary (ADR "the schedule is solved; the
  // call is pinned" — the UI never blurs an estimate into a promise): a scheduled
  // time that is still the solver's plan says `est`; a called fixture wears its
  // called-at badge (and, past the first call, what the corrections cost).
  const notified = notifiedLabel(match.callNotifiedCount)
  return (
    <div
      data-testid={`schedule-match-${match.fixtureId}`}
      className="flex flex-col gap-1 border-t border-[color:var(--border-subtle)] px-4 py-2.5 first:border-t-0"
    >
      <div className="flex flex-wrap items-baseline gap-x-2 text-[13px]">
        {showTime && (
          <span className="font-mono text-[12px] tabular-nums text-[color:var(--ball-500)]">
            {time || EM_DASH}
            {time && match.tier === 'estimate' && (
              <span
                data-testid={`schedule-est-${match.fixtureId}`}
                className="text-[10px] text-[color:var(--fg-3)]"
              >
                {' '}
                · est
              </span>
            )}
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
        {match.pinnedAt !== null && !isDecided(match.match?.status ?? null) && (
          <>
            {/* The badge rides the PIN, not the tier: go-live materializes
                every round-robin fixture into an `in_progress` match, so a
                called match is tier `started` from the first live second and
                must still show what the director promised (the QA-caught
                gap). Only a decided match (completed/voided, `isDecided`)
                retires the badge — its promise is no longer outstanding.
                Pinned is not told: only a fixture whose players were actually
                NOTIFIED wears the called-at time — a silent pin (a director's
                pre-live placement, count 0) says `Pinned`, claiming no call
                and no notification that never happened. */}
            <span
              data-testid={`schedule-called-${match.fixtureId}`}
              className="inline-flex items-center gap-1 self-center rounded-full border border-[color:var(--ball-500)] bg-[color:var(--ball-500)]/20 px-1.5 py-0.5 font-mono text-[10px] font-medium tabular-nums text-[color:var(--fg-1)]"
            >
              <Pin size={10} aria-hidden className="shrink-0" />
              {isTold(match) ? calledAtLabel(match.pinnedAt) : 'Pinned'}
            </span>
            {notified && (
              <span
                data-testid={`schedule-notified-${match.fixtureId}`}
                className="font-mono text-[10px] tabular-nums text-[color:var(--fg-3)]"
              >
                {notified}
              </span>
            )}
          </>
        )}
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
          status={status}
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
  status,
  canEdit,
  onSubmit,
  isPending,
}: {
  column: ScheduleTable
  tables: TournamentTable[]
  status: TournamentStatus
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
          status={status}
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
  const requestSolve = useRequestScheduleSolve(tournament.id)
  // Memoized on the query cache's stable references: the reduction walks every
  // fixture of every event, so it should re-run when the data changes, not on
  // every poll-driven re-render.
  const schedule = useMemo(() => buildSchedule(tournament, tables), [tournament, tables])
  const [view, setView] = useState<ScheduleView>('list')
  // Freshness is POLLING while this tab is on screen (ADR "the schedule is
  // solved"): ~3s while a solve is in flight, ~15s while the tournament is live,
  // none otherwise. Mounted here — not on the page — so only the Schedule tab
  // ever polls, and only while it is the active tab.
  useSchedulePolling(tournament.id)

  const onSubmit = (fixtureId: string, body: PlacementBody) =>
    place.mutateAsync({ fixtureId, body }).then(() => undefined)

  // The boards' shared derivation — only paid for when a board is on screen,
  // and only re-run when the data (or the view) changes.
  const board = useMemo(
    () => (view === 'list' ? null : buildTimelineBoard(tournament, tables)),
    [view, tournament, tables],
  )

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

      {/* The solve strip renders in EVERY schedule state, the empty one included:
          "no plan yet" over an uncut tournament is exactly where the owner meets
          the designed 422 ("cut a draw first") if they run it early. */}
      <SolveStrip
        solve={tournament.latestScheduleSolve}
        canEdit={canEdit}
        onRun={() => requestSolve.mutateAsync().then(() => undefined)}
      />

      {schedule.isEmpty ? (
        <EmptyState
          icon={<CalendarClock size={28} />}
          title="Nothing to schedule yet"
          hint="Cut a draw for an event to see its matches here."
        />
      ) : (
        <>
          {/* Three readings of one schedule; the list stays the default so
              nothing regresses. The legend rides with the boards — the list
              has no bars to explain. */}
          <div className="mb-5 flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
            <ToggleGroup
              type="single"
              value={view}
              onValueChange={(v) => {
                if (isScheduleView(v)) setView(v)
              }}
              aria-label="Schedule view"
              data-testid="schedule-view-toggle"
              className="w-fit"
            >
              <ToggleGroupItem value="list">
                <List size={14} /> List
              </ToggleGroupItem>
              <ToggleGroupItem value="gantt">
                <LayoutGrid size={14} /> Gantt
              </ToggleGroupItem>
              <ToggleGroupItem value="players">
                <Users size={14} /> Player timeline
              </ToggleGroupItem>
            </ToggleGroup>
            {view !== 'list' && <TierLegend />}
          </div>

          {board &&
            (!board.hasBars ? (
              // Fixtures exist but nothing is placed: the boards' designed
              // prompt — the Run-scheduler button is right above, on the strip.
              <BoardEmpty canEdit={canEdit} />
            ) : view === 'gantt' ? (
              <GanttBoard board={board} />
            ) : (
              <PlayerTimelineBoard board={board} />
            ))}

          {view === 'list' && (
            <div className="flex flex-col gap-6">
          {schedule.tables.map((column) => (
            <TableColumn
              key={column.tableId}
              column={column}
              tables={tables}
              status={tournament.status}
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
                    status={tournament.status}
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
        </>
      )}
    </div>
  )
}
