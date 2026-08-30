import {
  CalendarClock,
  FlaskConical,
  LayoutGrid,
  List,
  MapPin,
  Pencil,
  Pin,
  Plus,
  Users,
} from 'lucide-react'
import { Loader2 } from 'lucide-react'
import { useMemo, useState } from 'react'

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
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
import { solveInFlight } from '../data/solve'
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
import { SchedulePreviewModal } from './schedule-preview-modal'
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

/** The director's placement editor for one match (owner only): pick a **table** (a
 * booked-reservation match's own reservation tables are marked as the natural suggestion)
 * and a **time** within the fixture's window, then Save — or Clear an existing placement.
 *
 * Only the **time** is asked: the placement's date is fixed by the match's reservation —
 * its group's reservation Slot, or its event's own Slot when it has no group (ADR-0790,
 * ADR 20260807) —
 * so the naive timestamp is composed from that date + this time (`composeScheduledStart`)
 * — no `Date`, no timezone. The control is a plain reveal-on-click panel, not a portal'd
 * popover, so what a director (and a test) sees is the DOM, in place. */
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

  // The `reservation table` mark is carried only by a BOOKED-reservation match (ADR
  // 20260807). A mark is information only when it discriminates: an event-wide match is
  // suggested every table in the tournament, so marking all of them would say nothing —
  // and would name a reservation the match does not have.
  const options = tables.map((t) => ({
    value: t.id,
    label:
      match.reservation === 'booked' && match.suggestedTableIds.includes(t.id)
        ? `${t.label} · reservation table`
        : t.label,
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
  placementActionable,
  onSubmit,
  isPending,
  showTime,
}: {
  match: ScheduleMatch
  tables: TournamentTable[]
  status: TournamentStatus
  canEdit: boolean
  /** Whether a placement write may be offered on the data being rendered. False
   * while a schedule solve is queued/running: the row's placement is the
   * server's last accepted one and a fresh plan may replace it at the next
   * poll, so acting on it would be acting on stale data. */
  placementActionable: boolean
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
  // #1537: the table left the venue catalogue entirely (a dangling `tableId`) — the
  // SAME derivation `TableColumn` uses for its own "Removed from the catalogue"
  // label (`column.table === null`, computed there from this same `tables`
  // catalogue). That label already says the table is gone; a second note here
  // saying the table isn't part of the reservation would be true but redundant —
  // of course a table that no longer exists in the tournament isn't part of any
  // reservation's slice of it. The WINDOW note is unaffected: it is about the time,
  // not the table, so it stays independent.
  const tableRemovedFromCatalogue =
    match.tableId !== null && !tables.some((t) => t.id === match.tableId)
  const showOffReservationNote =
    match.tableOffReservation === true && !tableRemovedFromCatalogue
  const showOutsideWindowNote = match.startOutsideReservationWindow === true
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
      {/* #1537: the reservation-stranding notes — a plainly-worded fact, never an
          accusation (a director's deliberate off-reservation placement reads the
          same as an accidental strand left by a reservation edit). Unconditional —
          shown to every viewer, not gated on `canEdit` like the control below —
          because anyone reading the schedule benefits from knowing a placement no
          longer matches its reservation. Both notes can fire on the same row (a
          half-placement can only ever trip one; a full one can trip both), and
          neither hides the other. */}
      {(showOffReservationNote || showOutsideWindowNote) && (
        <div className="flex flex-col gap-0.5 text-[11px] text-[color:var(--fg-3)]">
          {showOffReservationNote && (
            <span data-testid={`schedule-off-reservation-${match.fixtureId}`}>
              {match.reservationName
                ? `This table isn't part of ${match.reservationName}'s reservation.`
                : "This table isn't part of the event's reserved tables."}
            </span>
          )}
          {showOutsideWindowNote && (
            <span data-testid={`schedule-outside-window-${match.fixtureId}`}>
              {match.reservationName
                ? `This time is outside ${match.reservationName}'s reservation window.`
                : "This time is outside the event's own window."}
            </span>
          )}
        </div>
      )}
      {/* The control, for the director alone. A finished match (`!placeable`) is frozen
          server-side, so it gets no control — not a disabled one (ADR-0015). A non-owner
          gets none either way. While a solve is in flight the placements on screen are
          provisional (the last accepted plan), so the control is withheld there too —
          the same hidden-not-disabled rule, and the same restoration the moment a
          terminal payload lands. */}
      {canEdit && match.placeable && placementActionable && (
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

/** The reserved windows — real, director-entered data (ADR-0790), kept visible as
 * lightweight context beneath the real matches: which reservations book which tables, when.
 * Not the schedule itself (that is the matches above); an *input* to it. */
const ReservedWindows = ({ tournament }: { tournament: Tournament }) => {
  const rows = tournament.events.flatMap((event) =>
    event.reservations.map((reservation) => ({
      key: `${event.id}-${reservation.id}`,
      event: event.name,
      reservation: reservation.name,
      date: reservation.slot.date,
      window: fmtTimeWindow(reservation.slot.start, reservation.slot.end),
      tables: reservation.tableIds.length,
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
            <span className="text-[color:var(--fg-2)]">{row.reservation}</span>
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
  placementActionable,
  onSubmit,
  isPending,
}: {
  column: ScheduleTable
  tables: TournamentTable[]
  status: TournamentStatus
  canEdit: boolean
  /** The provisional-placement gate, threaded to every row — see `MatchRow`. */
  placementActionable: boolean
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
          placementActionable={placementActionable}
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
 * never disabled). While a solve is queued/running the placements on screen are the last
 * accepted plan: the tab says so and withholds the control (`placementActionable`) until
 * a terminal solve lands. Conflict flagging (double-booked tables/players) is a later
 * scheduler slice and deliberately absent here — placement is soft (ADR-0790).
 */
export const ScheduleTab = ({ tournament, tables }: ScheduleTabProps) => {
  const canEdit = tournament.canEdit
  const place = usePlaceFixture(tournament.id)
  const requestSolve = useRequestScheduleSolve(tournament.id)
  // **Provisional placements** (#1614): while the latest solve is `queued` or
  // `running`, the fixture placements this tab renders are the server's LAST
  // ACCEPTED plan — the go-live transition commits matches and enqueues the
  // solve before the worker applies its placements, and the same asynchronous
  // window opens for every other trigger (`match_completed`, `settings_changed`,
  // `manual`, `pin_tick`, `rerun` all share the one ledger and the one guarded
  // apply). The parsed solve status is independent of trigger, so one flag
  // covers them all: the tab keeps the last-good schedule on screen, marks it
  // visibly as an update in progress, and withholds Place/Move — acting on a
  // placement that a landing solve may replace is exactly how the Schedule tab
  // ended up offering actions on a fixture the worker had already called.
  // A terminal solve (`succeeded`/`infeasible`/`failed`) — or no solve — makes
  // the placements actionable again; the poll carries that payload in without
  // any reload, and a FAILED refetch cannot flip the flag (it derives from the
  // last-good cache entry, which stays whatever it was).
  //
  // **The gate closes around the director's own click too** (#1614, the same
  // race by hand): a manual "Run scheduler" has the previous terminal (or null)
  // solve in `tournament.latestScheduleSolve` for the whole request — and the
  // fire-and-forget invalidate that follows it re-reads only at the network's
  // speed. Two bridges hold the gate shut across that window, so Place/Move
  // never sit on data the just-accepted run may replace:
  //
  // 1. **While the request is out** (`requestSolve.isPending`) — nothing has
  //    landed yet, so the request state is the only signal there is. A refused
  //    run (the 422 "cut a draw first") flashes the notice only for the request's
  //    own length, which is the honest reading of "an update is in progress".
  // 2. **From the 202 onward**, `useRequestScheduleSolve` writes the accepted
  //    queued row into the detail cache (`./api`), so this prop carries it the
  //    moment the server accepts — no poll, no refetch needed. The next detail
  //    response (the settle refetch, then the ~3s in-flight poll) hands back the
  //    same row or a later one, and a terminal payload restores the actions, as
  //    the tests below pin.
  const placementActionable =
    !solveInFlight(tournament.latestScheduleSolve) && !requestSolve.isPending
  // Memoized on the query cache's stable references: the reduction walks every
  // fixture of every event, so it should re-run when the data changes, not on
  // every poll-driven re-render.
  const schedule = useMemo(() => buildSchedule(tournament, tables), [tournament, tables])
  const [view, setView] = useState<ScheduleView>('list')
  // The **Preview schedule** trigger is the owner's alone and pre-live only (ADR
  // "a schedule preview is a non-persistent solve over a synthetic field": the
  // verb is owner-gated and refused on `live`/`archived`). A non-owner, or a
  // tournament past `published`, is offered nothing — the affordance is hidden,
  // never disabled (ADR-0015). Open-state lives here; the modal drives the solve.
  const [previewOpen, setPreviewOpen] = useState(false)
  const canPreview =
    canEdit &&
    (tournament.status === 'draft' || tournament.status === 'published')
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
            ? // The date's source is named for BOTH kinds of match (ADR 20260807): a
              // booked-reservation match takes its reservation's window, and an event-wide
              // one — a bracket, a swiss round, a knockout stage — takes its event's own.
              'Every match, by table. Place a match on a table and a predicted time — the date comes from its reservation window, or from its event window when it has no reservation.'
            : 'Every match, by table, with its predicted start time.'
        }
        action={
          canPreview && (
            <Button
              variant="outline"
              size="sm"
              data-testid="preview-schedule-trigger"
              onClick={() => setPreviewOpen(true)}
            >
              <FlaskConical size={14} />
              Preview schedule
            </Button>
          )
        }
      />

      {/* The pre-live dry run over a synthetic field — mounted only for the
          owner, so a non-owner never even carries its open-state. The modal
          enqueues on open and cancels on close; nothing is created or saved. */}
      {canPreview && (
        <SchedulePreviewModal
          open={previewOpen}
          onOpenChange={setPreviewOpen}
          tournamentId={tournament.id}
          events={tournament.events.map((event) => ({
            id: event.id,
            name: event.name,
          }))}
        />
      )}

      {/* The solve strip renders in EVERY schedule state, the empty one included:
          "no plan yet" over an uncut tournament is exactly where the owner meets
          the designed 422 ("cut a draw first") if they run it early. */}
      <SolveStrip
        solve={tournament.latestScheduleSolve}
        canEdit={canEdit}
        onRun={() => requestSolve.mutateAsync().then(() => undefined)}
      />

      {/* The provisional half of the same fact: the strip above says the solver
          is working, and THIS says what that means for the placements below —
          the schedule on screen is the last accepted one, not the plan being
          computed. Owner and viewer alike (a non-owner reads the same
          schedule); `role="status"` keeps it a polite announcement, since the
          strip's own `aria-live` region already speaks the solve state. Gone
          the moment a terminal payload arrives — no reload, no navigation. */}
      {!placementActionable && (
        <Alert
          role="status"
          data-testid="schedule-placement-updating"
          className="mb-6"
        >
          <Loader2 size={16} className="animate-spin" />
          <AlertTitle>Placement updates in progress</AlertTitle>
          <AlertDescription>
            The scheduler is placing matches on tables. The placements shown
            are the last accepted ones and can change when it finishes.
          </AlertDescription>
        </Alert>
      )}

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
              placementActionable={placementActionable}
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
                    placementActionable={placementActionable}
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
