// The **schedule board** derivation (ADR "the schedule is solved; the call is
// pinned"): the pure reduction behind the Schedule tab's Gantt and player-timeline
// views. A tournament + its table catalogue in, one `TimelineBoard` out — rows of
// tables, rows of players, positioned bars, and the fixtures that have no position
// yet. Pure, so it is unit-tested (`./timeline.test.ts`) rather than asserted
// through a DOM — the `./schedule.ts` shape.
//
// Everything here is **naive wall-clock** (ADR-0790): a placement's
// `scheduledStart` and a pool's Slot live in the venue's own frame, so positions
// are computed by string/segment arithmetic on `YYYY-MM-DD` + `HH:MM` — day
// offsets via UTC-midnight subtraction (both sides UTC, so no timezone can leak
// in), never a local `Date` of a wall-clock instant.

import type { MatchStatus } from '@/api/matches'

import { TBD_LABEL, WITHDRAWN_LABEL } from './draw'
import type {
  Entrant,
  Fixture,
  MatchLength,
  Tournament,
  TournamentEvent,
  TournamentTable,
} from './types'

// ----- the duration estimate ---------------------------------------------------

/**
 * How long a match of this format is **estimated** to occupy its table, in
 * minutes.
 *
 * ⚠️ A deliberate client-side **mirror of the server's `match_minutes`**
 * (`api/app/scheduling.py`) — the solver plans with these exact figures, and a bar
 * drawn with different ones would show a board the solver never computed. Keyed
 * over `MatchLength` so a new legal length is a compile error here until it is
 * given a duration, exactly as it is there. If the server ever learns durations
 * (per-event estimates), this mirror is replaced by a wire field, not extended.
 */
const ESTIMATED_MATCH_MINUTES: Record<MatchLength, number> = {
  1: 15,
  3: 25,
  5: 35,
  7: 45,
}

export function estimatedMatchMinutes(lengthGames: MatchLength): number {
  return ESTIMATED_MATCH_MINUTES[lengthGames]
}

// ----- the three tiers -----------------------------------------------------------

/**
 * How firm a bar's time is — the board's whole vocabulary (ADR "the schedule is
 * solved; the call is pinned": a plan is an estimate, a call is a promise).
 *
 * - `estimate` — placed (by a solve), unpinned: the solver may still move it,
 *   and the board must say so.
 * - `called` — `pinnedAt` is set: a fixed interval no later solve rearranges.
 *   Pinned-ness and TOLD-ness are two facts, not one: every manual placement
 *   pins (a director's hand is a commitment), but only a LIVE one notifies —
 *   a pre-live manual placement is a **silent pin** (`callNotifiedCount` 0),
 *   and the words (`tierSentence`, the markers) must not claim the players
 *   were notified unless they were.
 * - `started` — the fixture's match is `in_progress`, `completed` or `voided`:
 *   the placement is history (or unfolding), not a plan of any kind. Takes
 *   precedence over the pin — every called match eventually starts.
 */
export type TimelineTier = 'estimate' | 'called' | 'started'

const STARTED_STATUSES: ReadonlySet<MatchStatus> = new Set([
  'in_progress',
  'completed',
  'voided',
])

/** The tier of one fixture: started beats called beats estimate. */
export function fixtureTier(fixture: Fixture): TimelineTier {
  if (fixture.matchStatus !== null && STARTED_STATUSES.has(fixture.matchStatus))
    return 'started'
  if (fixture.pinnedAt !== null) return 'called'
  return 'estimate'
}

/** The board's own status words — a `started` bar's detail line. Local to the
 * board on purpose (the schedule list's `scheduleStatusLabel` says "Unplayed"
 * for an in-progress match, which is the right word in a to-do list and the
 * wrong one on a live bar). Keyed so a new `MatchStatus` is a compile error
 * until it has a word here. */
const BOARD_STATUS_LABEL: Record<MatchStatus, string> = {
  pending: 'Not started',
  in_progress: 'In progress',
  completed: 'Completed',
  voided: 'Voided',
}

/** What a call **cost**, made visible (ADR "the schedule is solved; the call is
 * pinned": called fixtures carry a visible called-at / notified-count marker):
 * `Called 08:50` — the wall-clock minute the promise was made. The time is read
 * straight off the naive `pinnedAt` stamp, the same frame every other schedule
 * clock is in. */
export function calledAtLabel(pinnedAt: string): string {
  const [, time] = pinnedAt.split('T')
  return `Called ${time ? time.slice(0, 5) : '00:00'}`
}

/** The notified-count half of the marker: `notified 2×` — but only once the
 * fixture's players have been notified MORE than once (a correction went out).
 * A single call is the ordinary case and earns no counter; `null` says so, and
 * the caller renders nothing. */
export function notifiedLabel(callNotifiedCount: number): string | null {
  return callNotifiedCount > 1 ? `notified ${callNotifiedCount}×` : null
}

/** What a bar's tier reads as, in one sentence — the tooltip's last line and the
 * tail of the bar's accessible name. The estimate/called copy is the ADR's own
 * distinction; a started bar reads as its match's actual state.
 *
 * The `called` tier needs the notified count, because pinned is not told: a
 * **silent pin** (a director's pre-live placement — pinned, `callNotifiedCount`
 * 0) must not claim "the players were notified" when nobody was. */
export function tierSentence(
  tier: TimelineTier,
  status: MatchStatus | null,
  callNotifiedCount: number,
): string {
  switch (tier) {
    case 'estimate':
      return 'Estimate — the scheduler may still move it'
    case 'called':
      return callNotifiedCount > 0
        ? 'Called — the players were notified'
        : 'Pinned — placed by the director'
    case 'started':
      return status === null ? 'Started' : BOARD_STATUS_LABEL[status]
    default: {
      const exhaustive: never = tier
      return exhaustive
    }
  }
}

// ----- wall-clock arithmetic -----------------------------------------------------

/** Whole days from `origin` to `date` (both `YYYY-MM-DD`), by UTC-midnight
 * subtraction — both sides in the same fictitious frame, so this is calendar
 * arithmetic, not timezone math (ADR-0790). */
function dayOffset(date: string, origin: string): number {
  const [oy, om, od] = origin.split('-').map(Number)
  const [dy, dm, dd] = date.split('-').map(Number)
  return Math.round((Date.UTC(dy, dm - 1, dd) - Date.UTC(oy, om - 1, od)) / 86_400_000)
}

/** Minutes from `origin`'s midnight to `date` `HH:MM`. */
function minutesAt(date: string, time: string, origin: string): number {
  const [h, m] = time.split(':').map(Number)
  return dayOffset(date, origin) * 1440 + (h || 0) * 60 + (m || 0)
}

/** A board minute as venue wall-clock `HH:MM` (wraps across days). */
export function fmtBoardClock(min: number): string {
  const ofDay = ((min % 1440) + 1440) % 1440
  const h = Math.floor(ofDay / 60)
  const m = ofDay % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

/** A placement timestamp (`YYYY-MM-DDTHH:MM[:SS]`) split into its date and
 * `HH:MM`, tolerantly: a bare date reads as midnight rather than crashing the
 * board over one malformed stamp. */
function splitStamp(scheduledStart: string): { date: string; time: string } {
  const [date, time] = scheduledStart.split('T')
  return { date, time: time ? time.slice(0, 5) : '00:00' }
}

/** One labelled tick of the time axis. */
export interface AxisTick {
  min: number
  label: string
}

/** Ticks for the visible window: every 30 minutes, opening to hourly once the
 * window is longer than six hours (the label density the px scale can carry). */
export function axisTicks(startMin: number, endMin: number): AxisTick[] {
  const step = endMin - startMin > 360 ? 60 : 30
  const ticks: AxisTick[] = []
  for (let min = Math.ceil(startMin / step) * step; min <= endMin; min += step) {
    ticks.push({ min, label: fmtBoardClock(min) })
  }
  return ticks
}

/** The boards' fixed horizontal scale. One constant so the axis and every bar
 * agree; the boards scroll inside their own container rather than compressing. */
export const PX_PER_MIN = 3

// ----- the board -----------------------------------------------------------------

/** One placed fixture as a positioned bar. Positions are minutes since the
 * board's `originDate` midnight; clocks are the venue's wall-clock words for the
 * same instants. */
export interface TimelineBarData {
  fixtureId: string
  eventName: string
  /** The pool's name, or `null` for an un-pooled (knockout) fixture. */
  poolName: string | null
  /** The pairing — `player.1 vs player.4`, with the draw's own words for an
   * unknown side (`TBD` / `Withdrawn`), never a blank. */
  label: string
  /** The two sides individually — what a player row derives its "vs X" from. */
  a: string
  b: string
  tableId: string
  /** The table's catalogue label, or its raw id when the catalogue no longer
   * lists it (shown, never dropped — the `./schedule.ts` stance). */
  tableLabel: string
  /** The placement's date (`YYYY-MM-DD`). */
  date: string
  startMin: number
  endMin: number
  /** The **estimated** duration (`estimatedMatchMinutes`) — the bar's width. */
  durationMin: number
  startClock: string
  endClock: string
  tier: TimelineTier
  /** The materialized match's live status, or `null` while the fixture is still
   * a planned pairing. */
  status: MatchStatus | null
  pinnedAt: string | null
  /** How many call/correction notifications this fixture's players have received
   * — `0` for a never-called fixture. Carried so a called bar can show what its
   * promise cost (`notifiedLabel`). */
  callNotifiedCount: number
}

/** One table's row on the Gantt: every tournament table gets a row, bars or
 * not — an empty table is a fact about the day, not a rendering gap. */
export interface TimelineTableRow {
  tableId: string
  /** The catalogue label, or the raw id for a dangling ref. */
  label: string
  /** False when a placement names a table the catalogue no longer lists. */
  known: boolean
  bars: TimelineBarData[]
}

/** One entrant's bar: the shared bar plus who they face. */
export interface TimelinePlayerBarData extends TimelineBarData {
  opponent: string
}

/** One entrant's row on the player timeline — a player with at least one
 * fixture. `bars` holds only their *placed* fixtures; a row whose fixtures are
 * all unplaced renders an honest empty track. */
export interface TimelinePlayerRow {
  userId: string
  username: string
  bars: TimelinePlayerBarData[]
}

/** A fixture the boards cannot draw: no table, or no time (a table-only
 * placement is still not a position on a time axis). Listed in the "not yet
 * scheduled" rail, never dropped. */
export interface UnscheduledFixture {
  fixtureId: string
  eventName: string
  poolName: string | null
  label: string
  /** The half-placement's table label, when it has a table but no time. */
  tableLabel: string | null
  statusLabel: string
}

/**
 * The whole board: one visible window, the table rows, the player rows, and the
 * unscheduled rail. The window runs from the earliest pool-window start to the
 * latest placement end (whichever is later than its window), padded to the
 * half-hour — pools' windows alone when nothing is placed yet (the chore's
 * fallback), so an empty board still shows the day it is empty *of*.
 */
export interface TimelineBoard {
  /** The date board minute 0 falls on (its midnight). */
  originDate: string
  startMin: number
  endMin: number
  tables: TimelineTableRow[]
  players: TimelinePlayerRow[]
  unscheduled: UnscheduledFixture[]
  /** False while nothing is placed — the boards' designed "run the scheduler"
   * empty state, never an error. */
  hasBars: boolean
}

/** The same side join the schedule list makes (`./schedule.ts` keeps its own,
 * per the module-local convention there): username, or the draw's own words. */
function sideOf(entryId: string | null, byId: Map<string, Entrant>): string {
  if (entryId === null) return TBD_LABEL
  const entrant = byId.get(entryId)
  return entrant ? entrant.username : WITHDRAWN_LABEL
}

function statusLabelOf(fixture: Fixture): string {
  return fixture.matchStatus === null
    ? BOARD_STATUS_LABEL.pending
    : BOARD_STATUS_LABEL[fixture.matchStatus]
}

interface EventFixture {
  fixture: Fixture
  event: TournamentEvent
  entrantById: Map<string, Entrant>
}

/**
 * Reduce a tournament (+ its table catalogue) to its schedule board.
 *
 * Grouping and ordering are all decided here (bars sorted by start, rows in the
 * tournament's own table order / username order) — order is a claim about
 * untrusted data like any other (`./schedule.ts`).
 */
export function buildTimelineBoard(
  tournament: Tournament,
  catalogue: TournamentTable[],
): TimelineBoard {
  const tableById = new Map(catalogue.map((t) => [t.id, t]))

  // Every fixture, joined to its event once.
  const all: EventFixture[] = []
  for (const event of tournament.events) {
    const entrantById = new Map(event.entrants.map((e) => [e.id, e]))
    for (const fixture of event.fixtures) {
      all.push({ fixture, event, entrantById })
    }
  }

  // ---- the window's raw candidates, as (date, HH:MM) pairs -------------------
  const starts: { date: string; time: string }[] = []
  const ends: { date: string; time: string }[] = []
  for (const event of tournament.events) {
    if (event.fixtures.length === 0) continue
    // Pool windows are the day's reserved shape; an un-pooled draw falls back to
    // the event's own Slot (the same rule a placement's date follows, ADR-0790).
    const slots =
      event.pools.length > 0 ? event.pools.map((p) => p.slot) : [event.slot]
    for (const slot of slots) {
      starts.push({ date: slot.date, time: slot.start })
      ends.push({ date: slot.date, time: slot.end })
    }
  }
  for (const { fixture } of all) {
    if (fixture.scheduledStart === null || fixture.tableId === null) continue
    // Placements join the origin vote here; their minutes join min/max in the
    // bars pass below (start AND estimated end), once there is an origin to
    // count from.
    starts.push(splitStamp(fixture.scheduledStart))
  }

  // Origin: the earliest date named anywhere (string compare is date order for
  // `YYYY-MM-DD`). A tournament with no drawn events has no candidates; the
  // board is not rendered then, but stay total on principle.
  const allDates = [...starts, ...ends].map((c) => c.date)
  const originDate =
    allDates.length > 0
      ? allDates.reduce((a, b) => (a < b ? a : b))
      : (tournament.startDate ?? '2000-01-01')

  let min = Number.POSITIVE_INFINITY
  let max = Number.NEGATIVE_INFINITY
  for (const c of starts) min = Math.min(min, minutesAt(c.date, c.time, originDate))
  for (const c of ends) max = Math.max(max, minutesAt(c.date, c.time, originDate))

  // ---- bars -------------------------------------------------------------------
  const barByFixture = new Map<string, TimelineBarData>()
  for (const { fixture, event, entrantById } of all) {
    if (fixture.tableId === null || fixture.scheduledStart === null) continue
    const stamp = splitStamp(fixture.scheduledStart)
    const startMin = minutesAt(stamp.date, stamp.time, originDate)
    const durationMin = estimatedMatchMinutes(event.match.lengthGames)
    const endMin = startMin + durationMin
    const pool = event.pools.find((p) => p.id === fixture.poolId) ?? null
    const a = sideOf(fixture.entryAId, entrantById)
    const b = sideOf(fixture.entryBId, entrantById)
    barByFixture.set(fixture.id, {
      fixtureId: fixture.id,
      eventName: event.name,
      poolName: pool?.name ?? null,
      label: `${a} vs ${b}`,
      a,
      b,
      tableId: fixture.tableId,
      tableLabel: tableById.get(fixture.tableId)?.label ?? fixture.tableId,
      date: stamp.date,
      startMin,
      endMin,
      durationMin,
      startClock: fmtBoardClock(startMin),
      endClock: fmtBoardClock(endMin),
      tier: fixtureTier(fixture),
      status: fixture.matchStatus,
      pinnedAt: fixture.pinnedAt,
      callNotifiedCount: fixture.callNotifiedCount,
    })
    min = Math.min(min, startMin)
    max = Math.max(max, endMin)
  }

  if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) {
    // Nothing anywhere to size a window from: show a token hour rather than a
    // zero-width track. (Reached only when no drawn event exists.)
    min = 9 * 60
    max = 10 * 60
  }

  // Pad to the half-hour so the axis opens on a round tick.
  const startMin = Math.floor(min / 30) * 30
  const endMin = Math.ceil(max / 30) * 30

  // ---- table rows: the tournament's tables, dangling refs appended -----------
  const rows = new Map<string, TimelineTableRow>()
  for (const tableId of tournament.tableIds) {
    rows.set(tableId, {
      tableId,
      label: tableById.get(tableId)?.label ?? tableId,
      known: tableById.has(tableId),
      bars: [],
    })
  }
  for (const bar of barByFixture.values()) {
    // A placement can name a table the tournament (or the catalogue) no longer
    // lists — a dangling ref (ADR-0790). It gets a row under whatever name we
    // have, never dropped and never a crash.
    let row = rows.get(bar.tableId)
    if (!row) {
      row = { tableId: bar.tableId, label: bar.tableLabel, known: tableById.has(bar.tableId), bars: [] }
      rows.set(bar.tableId, row)
    }
    row.bars.push(bar)
  }
  const tables = [...rows.values()]
  for (const row of tables) row.bars.sort((x, y) => x.startMin - y.startMin)

  // ---- player rows: entrants with at least one fixture ------------------------
  const playerByUser = new Map<string, TimelinePlayerRow>()
  for (const { fixture, entrantById } of all) {
    for (const [entryId, otherEntryId] of [
      [fixture.entryAId, fixture.entryBId],
      [fixture.entryBId, fixture.entryAId],
    ] as const) {
      if (entryId === null) continue
      const entrant = entrantById.get(entryId)
      if (!entrant) continue // withdrawn: no longer an entrant, so no row of their own
      let row = playerByUser.get(entrant.userId)
      if (!row) {
        row = { userId: entrant.userId, username: entrant.username, bars: [] }
        playerByUser.set(entrant.userId, row)
      }
      const bar = barByFixture.get(fixture.id)
      if (bar) row.bars.push({ ...bar, opponent: sideOf(otherEntryId, entrantById) })
    }
  }
  const players = [...playerByUser.values()].sort((x, y) =>
    x.username.localeCompare(y.username),
  )
  for (const row of players) row.bars.sort((x, y) => x.startMin - y.startMin)

  // ---- the unscheduled rail ----------------------------------------------------
  const unscheduled: UnscheduledFixture[] = []
  for (const { fixture, event, entrantById } of all) {
    if (fixture.tableId !== null && fixture.scheduledStart !== null) continue
    const pool = event.pools.find((p) => p.id === fixture.poolId) ?? null
    unscheduled.push({
      fixtureId: fixture.id,
      eventName: event.name,
      poolName: pool?.name ?? null,
      label: `${sideOf(fixture.entryAId, entrantById)} vs ${sideOf(fixture.entryBId, entrantById)}`,
      tableLabel:
        fixture.tableId !== null
          ? (tableById.get(fixture.tableId)?.label ?? fixture.tableId)
          : null,
      statusLabel: statusLabelOf(fixture),
    })
  }

  return {
    originDate,
    startMin,
    endMin,
    tables,
    players,
    unscheduled,
    hasBars: barByFixture.size > 0,
  }
}
