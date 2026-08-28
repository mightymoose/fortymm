// The **schedule board** derivation (ADR "the schedule is solved; the call is
// pinned"): the pure reduction behind the Schedule tab's Gantt and player-timeline
// views. A tournament + its table catalogue in, one `TimelineBoard` out — rows of
// tables, rows of players, positioned bars, and the fixtures that have no position
// yet. Pure, so it is unit-tested (`./timeline.test.ts`) rather than asserted
// through a DOM — the `./schedule.ts` shape.
//
// Bar **geometry** is instant-based (ADR "tournament times are timezone-aware
// instants", superseding ADR-0790's naive-wall-clock frame): a placement's
// `scheduledStart` carries a raw UTC `instant`, and positions are differences of
// those instants — tz-agnostic arithmetic, no timezone library. A tournament-wide
// board can hold events in different timezones, so two bars at the same wall-clock
// are NOT the same instant; only differencing instants separates them honestly.
// The board's minute axis is anchored to the earliest bar's venue wall-clock (its
// server-rendered `localLabel`) so the decorative axis still reads in venue time,
// but every bar shows its OWN `localLabel` + `tzAbbrev` — the client never derives
// a wall-clock or picks a zone itself.

import type { MatchStatus } from '@/api/matches'

import {
  buildDrawIndex,
  fixtureGroupLabel,
  fixtureReservation,
  TBD_LABEL,
  WITHDRAWN_LABEL,
  type DrawIndex,
} from './draw'
import type {
  Entrant,
  Fixture,
  FixtureTime,
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
 *   precedence over the pin — every called match eventually starts. The TIER
 *   outranking the pin is a fact about the styling only: the call's marker
 *   (the list badge, the bar's `Called HH:MM` line) survives into this tier
 *   until the match is decided (`isDecided`), because a round-robin
 *   materializes EVERY fixture into an `in_progress` match at go-live — while
 *   live, `started` is the ordinary state of a called match, not proof it is
 *   being played.
 */
export type TimelineTier = 'estimate' | 'called' | 'started'

/** The tiers in the order a reader meets them (plan → promise → fact) — the one
 * list a per-tier surface (the legend) maps over, so a new tier cannot be
 * silently missing from it. */
export const TIMELINE_TIERS = [
  'estimate',
  'called',
  'started',
] as const satisfies readonly TimelineTier[]

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

/** **Told-ness is `pinnedAt` AND `callNotifiedCount > 0`**, never the count alone
 * (ADR "the schedule is solved; the call is pinned"): a call that was later
 * cancelled keeps its count — it is "how many times the players were told", and
 * a clear does not reset it — but drops its pin, so nobody holds that promise
 * any more. A type predicate, so a teller of a told fixture may read its
 * `pinnedAt` without a cast. */
export function isTold<
  F extends { pinnedAt: FixtureTime | null; callNotifiedCount: number },
>(fixture: F): fixture is F & { pinnedAt: FixtureTime } {
  return fixture.pinnedAt !== null && fixture.callNotifiedCount > 0
}

/** The board's own status words — a `started` bar's detail line and the
 * unscheduled rail's status. Local to the board on purpose (the schedule
 * list's `scheduleStatusLabel` says "Unplayed" for an in-progress match,
 * which is the right word in a to-do list). `in_progress` deliberately does
 * NOT say "In progress": on the wire it means the match was **materialized**
 * at go-live — created, scoreable — not that anyone is at the table, and a
 * board claiming live play for a match hours out would be lying (the ADR-0788
 * materialize-at-go-live consequence). Keyed so a new `MatchStatus` is a
 * compile error until it has a word here. */
const BOARD_STATUS_LABEL: Record<MatchStatus, string> = {
  pending: 'Not started',
  in_progress: 'Underway or up next',
  completed: 'Completed',
  voided: 'Voided',
}

/** A **decided** match — `completed` or `voided`: the promise a call made was
 * kept (or destroyed), so it is no longer outstanding. This — never the tier —
 * is what retires the call markers (the list badge, the bars' `Called HH:MM`
 * line): an `in_progress` match that was called still owes the director its
 * marker, because while live every materialized fixture is `in_progress` from
 * the first second, called or not. */
const DECIDED_STATUSES: ReadonlySet<MatchStatus> = new Set(['completed', 'voided'])

export function isDecided(status: MatchStatus | null): boolean {
  return status !== null && DECIDED_STATUSES.has(status)
}

/** One displayed `FixtureTime` as its venue-local words: `"6:00 PM CDT"` — the
 * server-rendered `localLabel` and its `tzAbbrev`, side by side (ADR "tournament times
 * are timezone-aware instants": a schedule surface always labels the timezone). The
 * client renders these verbatim; it never slices a datetime or picks a zone. */
export function fmtFixtureTime(time: FixtureTime): string {
  return `${time.localLabel} ${time.tzAbbrev}`
}

/** What a call **cost**, made visible (ADR "the schedule is solved; the call is
 * pinned": called fixtures carry a visible called-at / notified-count marker):
 * `Called 8:50 AM CDT` — the venue wall-clock minute the promise was made, straight
 * off the server's `pinnedAt` label (`fmtFixtureTime`). */
export function calledAtLabel(pinnedAt: FixtureTime): string {
  return `Called ${fmtFixtureTime(pinnedAt)}`
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
 * The `called` tier needs the fixture's pin facts, because pinned is not told
 * (`isTold`): a **silent pin** (a director's pre-live placement — pinned,
 * `callNotifiedCount` 0) must not claim "the players were notified" when nobody
 * was. */
export function tierSentence(
  tier: TimelineTier,
  status: MatchStatus | null,
  fixture: { pinnedAt: FixtureTime | null; callNotifiedCount: number },
): string {
  switch (tier) {
    case 'estimate':
      return 'Estimate — the scheduler may still move it'
    case 'called':
      return isTold(fixture)
        ? 'Called — the players were notified'
        : 'Pinned — placed by the director'
    case 'started':
      // `in_progress` means materialized — scoreable — not "being played": a
      // round-robin turns every fixture into an in_progress match at go-live,
      // so claiming live play here would lie about a match hours out. Say
      // what the status actually promises.
      if (status === 'in_progress') {
        return 'Underway or up next — scores can be entered'
      }
      return status === null ? 'Started' : BOARD_STATUS_LABEL[status]
    default: {
      const exhaustive: never = tier
      return exhaustive
    }
  }
}

// ----- instant geometry + venue-clock labels -------------------------------------

/** One `FixtureTime`'s absolute moment as epoch milliseconds — the only value the
 * board's geometry ever reads from a time (positions are *differences* of these).
 * `NaN` for an unparseable instant, which the board guards against; the string is
 * untrusted network data. `instant` is offset-bearing UTC (`…Z`), so `Date.parse`
 * is unambiguous and no timezone leaks in. */
export function instantMs(time: FixtureTime): number {
  return Date.parse(time.instant)
}

/** The venue wall-clock minutes-of-day of a server `localLabel` (`"6:00 PM"` → 1080)
 * — parsed, not computed: this reads the label the server already rendered in the
 * venue's timezone, so the board can ANCHOR its minute axis to the earliest bar's
 * wall-clock. It is not timezone math (no zone, no offset) — a 12-hour clock string
 * turned into minutes. `0` for a label that does not parse. */
export function parseLocalLabel(localLabel: string): number {
  const m = /^(\d{1,2}):(\d{2})\s*(AM|PM)$/i.exec(localLabel.trim())
  if (!m) return 0
  const hour12 = Number(m[1]) % 12
  const pm = m[3].toUpperCase() === 'PM'
  return (pm ? hour12 + 12 : hour12) * 60 + Number(m[2])
}

/** A board minute as a venue wall-clock 12-hour label (`"6:00 PM"`), wrapping across
 * days. Used only for a bar's projected END (`scheduledStart + an estimate`), which
 * has no server label of its own — the START and any real completion time come
 * straight from the server (`FixtureTime.localLabel`). */
export function fmt12(min: number): string {
  const ofDay = ((Math.round(min) % 1440) + 1440) % 1440
  const h24 = Math.floor(ofDay / 60)
  const m = ofDay % 60
  const ampm = h24 < 12 ? 'AM' : 'PM'
  const h12 = h24 % 12 || 12
  return `${h12}:${String(m).padStart(2, '0')} ${ampm}`
}

/** A board minute as venue wall-clock `HH:MM` (wraps across days) — the decorative
 * axis ruler's labels, in the origin bar's venue frame (the axis is `aria-hidden`;
 * every bar states its own timezone-labelled clock). */
export function fmtBoardClock(min: number): string {
  const ofDay = ((min % 1440) + 1440) % 1440
  const h = Math.floor(ofDay / 60)
  const m = ofDay % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
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

/** The floor on a bar's drawn duration — never zero-width or backwards, even if
 * `completedAt` somehow lands at or before `scheduledStart` (it shouldn't, but the
 * network is untrusted; see the `endMin` note on `TimelineBarData`). */
const MIN_BAR_DURATION_MIN = 1

// ----- the board -----------------------------------------------------------------

/** One placed fixture as a positioned bar. Positions (`startMin`/`endMin`) are
 * board minutes on an axis anchored to the earliest bar's venue wall-clock but
 * SPACED by real instant differences (ADR "tournament times are timezone-aware
 * instants"); the displayed clocks (`startClock`/`endClock`/`tz`) are the server's
 * own venue-local words for the bar's own timezone. */
export interface TimelineBarData {
  fixtureId: string
  eventName: string
  /** The fixture's group, position-derived (`Group A`, `Group B`, …, `groupLabel`,
   * `./draw`), or `null` for an un-grouped (knockout) fixture. Never a reservation's
   * director-typed name (ticket #1369: a group carries none). */
  groupLabel: string | null
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
  /** The placement's **venue** date (`YYYY-MM-DD`), from the fixture's group's
   * reservation Slot, or the event's when un-grouped — the day the venue is open, not
   * whatever calendar day the UTC instant happens to land on. */
  date: string
  startMin: number
  /** Where the bar ends. For a **decided** fixture (`completed`/`voided`) with a
   * `completedAt`, this is the *actual* end (`completedAt`), not a projection —
   * `startMin` still anchors to `scheduledStart` (we don't try to detect an
   * actual start), but the bar stops truthfully rather than running the estimate
   * past a match that has already finished. Every other fixture keeps the
   * estimated `startMin + durationMin`. */
  endMin: number
  /** The bar's width in minutes: the **estimated** duration
   * (`estimatedMatchMinutes`) for an undecided or still-estimate-only fixture, or
   * the actual `completedAt - scheduledStart` (clamped to `MIN_BAR_DURATION_MIN`)
   * once the match is decided and has a real completion time. */
  durationMin: number
  /** The bar's start, in the venue's own words (`scheduledStart.localLabel`, e.g.
   * `"9:00 AM"`) — the server's rendering, not a client-derived clock. */
  startClock: string
  /** The bar's end in venue words: a **decided** fixture's real `completedAt.localLabel`,
   * else the projected `startClock + estimate` (`fmt12`). */
  endClock: string
  /** The bar's DST-correct zone abbreviation (`scheduledStart.tzAbbrev`, e.g. `"CDT"`),
   * rendered beside the clocks so a multi-timezone board never conflates two frames. */
  tz: string
  tier: TimelineTier
  /** The materialized match's live status, or `null` while the fixture is still
   * a planned pairing. */
  status: MatchStatus | null
  pinnedAt: FixtureTime | null
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
  /** The rail's secondary line, venue-neutral on purpose: the **real** schedule fills it
   * with the fixture's derived `groupLabel` (`Group A`, `./draw`, ticket #1369 — a group
   * carries no name of its own), but the **preview** grid reuses this same rail
   * (`schedule-preview-modal.tsx`'s `fixtureToRailItem`) and fills it with the group
   * label AND the reservation's director-typed name, `Group C · Reservation A` (ticket
   * #1389): two groups routinely share one reservation there, so the reservation alone
   * would read the same on every card. Named `contextLabel`, not `groupLabel`, so the
   * field is honest about carrying either, and it stays one string so the rail needs no
   * per-producer shape. */
  contextLabel: string | null
  label: string
  /** The half-placement's table label, when it has a table but no time. */
  tableLabel: string | null
  statusLabel: string
}

/**
 * The whole board: one visible window, the table rows, the player rows, and the
 * unscheduled rail. The window runs from the earliest placed bar to the latest bar
 * end, padded to the half-hour. It is drawn only once something is placed
 * (`hasBars`); before that the Schedule tab shows the "run the scheduler" prompt,
 * so the window is a token hour rather than a reserved-slot projection (the slot
 * windows are naive venue wall-clock and cannot be placed on the instant axis
 * without the timezone math this model keeps off the client).
 */
export interface TimelineBoard {
  /** The **venue** date the earliest bar falls on (`YYYY-MM-DD`) — the day the
   * board reads as, from that bar's group's reservation/event Slot. */
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
  /** The event's groups/reservations, indexed once per event (`buildDrawIndex`) rather
   * than re-scanned per fixture — every fixture of the event shares it. */
  drawIndex: DrawIndex
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
    const drawIndex = buildDrawIndex(event)
    for (const fixture of event.fixtures) {
      all.push({ fixture, event, entrantById, drawIndex })
    }
  }

  // ---- origin: the earliest placed bar's instant + its venue anchor ----------
  // Geometry differences INSTANTS (tz-agnostic); the minute axis is anchored to
  // that earliest bar's venue wall-clock (its server `localLabel`) so the
  // decorative ruler still reads in venue time. Slot windows are naive wall-clock
  // and cannot join an instant axis without timezone math, so they no longer size
  // the board — it is only drawn once at least one bar exists (`hasBars`).
  const venueDateOf = (ef: EventFixture): string => {
    const { reservation } = fixtureReservation(ef.drawIndex, ef.fixture)
    return (reservation?.slot ?? ef.event.slot).date
  }

  let originMs = Number.POSITIVE_INFINITY
  let originAnchor: EventFixture | null = null
  for (const ef of all) {
    const { scheduledStart, tableId } = ef.fixture
    if (scheduledStart === null || tableId === null) continue
    const ms = instantMs(scheduledStart)
    if (Number.isFinite(ms) && ms < originMs) {
      originMs = ms
      originAnchor = ef
    }
  }

  // The board minute the origin bar sits on: its venue wall-clock, read off the
  // server's own label (never derived here).
  const wallMin0 =
    originAnchor !== null && originAnchor.fixture.scheduledStart !== null
      ? parseLocalLabel(originAnchor.fixture.scheduledStart.localLabel)
      : 0
  const originDate =
    originAnchor !== null
      ? venueDateOf(originAnchor)
      : (tournament.dateRange?.start ?? '2000-01-01')

  let min = Number.POSITIVE_INFINITY
  let max = Number.NEGATIVE_INFINITY

  // ---- bars -------------------------------------------------------------------
  const barByFixture = new Map<string, TimelineBarData>()
  for (const { fixture, event, entrantById, drawIndex } of all) {
    if (fixture.tableId === null || fixture.scheduledStart === null) continue
    const startInstant = instantMs(fixture.scheduledStart)
    if (!Number.isFinite(startInstant)) continue
    // Board minutes: the origin bar's venue wall-clock plus REAL elapsed minutes
    // to this bar (instant differencing). Two bars an hour apart sit 60 minutes
    // apart whatever their timezones.
    const startMin = wallMin0 + Math.round((startInstant - originMs) / 60_000)
    // A decided fixture (`completed`/`voided`) with a real `completedAt` draws its
    // ACTUAL end (an instant difference) instead of projecting the estimate past a
    // match that has already finished — `startMin` still anchors to
    // `scheduledStart` (we detect an actual end, not an actual start). Guard a
    // `completedAt` at/before the start (the network is untrusted) with a
    // 1-minute floor rather than a backwards/zero-width bar.
    let durationMin = estimatedMatchMinutes(event.match.lengthGames)
    const decided = isDecided(fixture.matchStatus) && fixture.completedAt !== null
    if (decided && fixture.completedAt !== null) {
      const completedInstant = instantMs(fixture.completedAt)
      if (Number.isFinite(completedInstant)) {
        durationMin = Math.max(
          MIN_BAR_DURATION_MIN,
          Math.round((completedInstant - startInstant) / 60_000),
        )
      }
    }
    const endMin = startMin + durationMin
    const { reservation } = fixtureReservation(drawIndex, fixture)
    const a = sideOf(fixture.entryAId, entrantById)
    const b = sideOf(fixture.entryBId, entrantById)
    // The end reads in the bar's OWN venue frame: a decided fixture's real
    // completion label, else the projected `start + estimate` (`fmt12` of the
    // bar's own wall-clock — never a zone the client picked).
    const endClock =
      decided && fixture.completedAt !== null
        ? fixture.completedAt.localLabel
        : fmt12(parseLocalLabel(fixture.scheduledStart.localLabel) + durationMin)
    barByFixture.set(fixture.id, {
      fixtureId: fixture.id,
      eventName: event.name,
      // Asked of the fixture's STAGE, never of whether it resolved a group
      // (`fixtureGroupLabel`, `./draw`): since #1483 a bracket or swiss fixture names
      // its stage's group too, and a bar reading "Championship Singles · Group A"
      // would name a group with no standings table behind it.
      groupLabel: fixtureGroupLabel(drawIndex, fixture),
      label: `${a} vs ${b}`,
      a,
      b,
      tableId: fixture.tableId,
      tableLabel: tableById.get(fixture.tableId)?.label ?? fixture.tableId,
      date: (reservation?.slot ?? event.slot).date,
      startMin,
      endMin,
      durationMin,
      startClock: fixture.scheduledStart.localLabel,
      endClock,
      tz: fixture.scheduledStart.tzAbbrev,
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
  for (const { fixture, event, entrantById, drawIndex } of all) {
    if (fixture.tableId !== null && fixture.scheduledStart !== null) continue
    unscheduled.push({
      fixtureId: fixture.id,
      eventName: event.name,
      // The same stage-first rule the bars use (`fixtureGroupLabel`, `./draw`): an
      // un-placed bracket fixture on this rail is not in "Group A" either.
      contextLabel: fixtureGroupLabel(drawIndex, fixture),
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
