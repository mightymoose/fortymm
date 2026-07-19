// What a tournament's **schedule** looks like to a reader (ADR-0790) — the pure
// derivation behind the Schedule tab.
//
// The schedule is **tournament-scoped, not per-event** (CONTEXT.md): the venue's tables
// are shared across events, so "two matches on one table at once" is a cross-event fact,
// and this reduces *every* event's fixtures into one view organized by the venue —
// grouped by table, plus an "awaiting placement" group for the fixtures no table/time
// has been chosen for yet.
//
// A fixture carries a **placement** (ADR-0790): `tableId` (a string ref into the
// tournament's table catalogue, like `poolId`) and a naive `scheduledStart` — a
// *predicted* wall-clock timestamp, not a promise. The placement's **date is fixed** by
// the fixture's pool Slot (or the event Slot when un-pooled), so a director only ever
// chooses a *time within that window*; `composeScheduledStart` puts the two back
// together, in the same naive frame the Slot is already in (never a `Date`/UTC coercion).
//
// All of it is a pure function of one tournament + its table catalogue, so it is
// unit-tested (`./schedule.test.ts`) rather than asserted through a DOM — the same shape
// `./draw.ts` takes for the same reason.

import type { MatchStatus } from '@/api/matches'

import { type FixtureMatch, type FixtureSide, TBD_LABEL, WITHDRAWN_LABEL } from './draw'
import { fixtureTier, fmtFixtureTime, isTold, type TimelineTier } from './timeline'
import type {
  Entrant,
  Fixture,
  FixtureTime,
  Slot,
  Tournament,
  TournamentEvent,
  TournamentStatus,
  TournamentTable,
} from './types'

/** A fixture the placement control cannot move: its match is `completed` or `voided`, so
 * its table and time are history and the PATCH would 409 (ADR-0790). Everything else — a
 * fixture with no match yet, or an `in_progress` one — is freely (re)placeable. */
const FROZEN_STATUSES: ReadonlySet<MatchStatus> = new Set(['completed', 'voided'])

/**
 * One fixture as a schedulable **match** on the tournament schedule (ADR-0790).
 *
 * It is keyed by the **fixture** id, not a match id: a placement lives on the fixture and
 * can be set before the match exists (a round-robin fixture is known at the cut), so the
 * fixture id is the stable address a placement PATCH is sent to.
 *
 * The two sides are joined to names exactly as the draw does (`FixtureSide`, `./draw`) —
 * an entrant's username, or `TBD` / `Withdrawn` — never a blank or a raw entry id.
 */
export interface ScheduleMatch {
  /** The fixture id — the address `usePlaceFixture` PATCHes. */
  fixtureId: string
  eventId: string
  eventName: string
  a: FixtureSide
  b: FixtureSide
  /** The materialized match, or `null` while the fixture is still a planned pairing —
   * the same lockstep pair the draw carries. `null` reads as "not started". */
  match: FixtureMatch | null
  /** The placement's table (`null` = unassigned), a string ref into the catalogue. */
  tableId: string | null
  /** The placement's predicted start, a `FixtureTime` (`null` = unscheduled) — a
   * venue-local label + tz abbrev for display, plus a UTC instant for ordering. */
  scheduledStart: FixtureTime | null
  /** The window whose **date** the placement is fixed to: the fixture's pool Slot, or the
   * event Slot when the fixture is un-pooled (ADR-0790). The time picker chooses within it. */
  window: Slot
  /** The tables the fixture's pool reserves — the natural suggestion for a placement
   * (empty for an un-pooled fixture, whose whole venue is fair game). */
  suggestedTableIds: string[]
  /** Whether the placement can still be changed. `false` once the match is
   * `completed`/`voided` — its placement is frozen server-side, so the control is hidden
   * rather than offered and refused (ADR-0790). */
  placeable: boolean
  /** How firm the time is — the boards' `estimate` / `called` / `started` vocabulary
   * (`fixtureTier`), so the LIST reads the same tier system the bars draw: an estimate
   * says `est`, a call carries its called-at badge, a started match reads as its status.
   * The list must not blur a promise into a plan any more than a bar may. */
  tier: TimelineTier
  /** When the fixture was **called** (`null` = never): the promise's own time, a
   * `FixtureTime`, shown on the row so a director sees what they told the players (ADR
   * "the schedule is solved; the call is pinned"). */
  pinnedAt: FixtureTime | null
  /** How many call/correction notifications the players have received — `0` until
   * called; `> 1` means a correction already spent their attention once. */
  callNotifiedCount: number
}

/**
 * One table's column on the schedule: the table (resolved from the catalogue) and its
 * matches in **predicted-time order**.
 *
 * `table` is `null` when a placement names a table the catalogue no longer lists — a
 * dangling ref a later catalogue edit can leave (ADR-0790: an unknown `table_id` is
 * *stored*, not refused). It is **shown** under its raw id, never dropped, exactly as a
 * withdrawn draw side is shown rather than blanked.
 */
export interface ScheduleTable {
  tableId: string
  table: TournamentTable | null
  matches: ScheduleMatch[]
}

/** A tournament's schedule: its matches grouped by table, plus the fixtures still
 * awaiting a placement. `isEmpty` is the designed "nothing to schedule" state — no
 * fixtures anywhere (no draw cut yet), never an error. */
export interface TournamentSchedule {
  /** One column per table that has at least one placed match, in catalogue order
   * (dangling refs last). */
  tables: ScheduleTable[]
  /** Fixtures with no table yet — a freshly-live tournament's every match starts here
   * (ADR-0790), not in an empty grid. */
  awaiting: ScheduleMatch[]
  /** True when there is no fixture anywhere to schedule. */
  isEmpty: boolean
}

/** Join one entry id to a side — TBD when the feeder is undecided (`null`), Withdrawn
 * when the event no longer lists the id, else the entrant's username. The same rule
 * `./draw.ts` joins a draw line by; kept local, like `./results.ts` keeps its own, so a
 * schedule row and a draw line derive independently rather than through a shared private. */
function sideOf(entryId: string | null, byId: Map<string, Entrant>): FixtureSide {
  if (entryId === null) return { kind: 'tbd' }
  const entrant = byId.get(entryId)
  return entrant ? { kind: 'entrant', name: entrant.username } : { kind: 'withdrawn' }
}

/** The materialized match of a fixture, or `null`. `matchId`/`matchStatus` move in
 * lockstep on the wire, so the `&&` is a belt against a half-materialized shape. */
function matchOf(fixture: Fixture): FixtureMatch | null {
  if (fixture.matchId === null || fixture.matchStatus === null) return null
  return { id: fixture.matchId, status: fixture.matchStatus }
}

function toScheduleMatch(
  fixture: Fixture,
  event: TournamentEvent,
  byId: Map<string, Entrant>,
  poolById: Map<string, TournamentEvent['pools'][number]>,
): ScheduleMatch {
  const pool = fixture.poolId !== null ? (poolById.get(fixture.poolId) ?? null) : null
  return {
    fixtureId: fixture.id,
    eventId: event.id,
    eventName: event.name,
    a: sideOf(fixture.entryAId, byId),
    b: sideOf(fixture.entryBId, byId),
    match: matchOf(fixture),
    tableId: fixture.tableId,
    scheduledStart: fixture.scheduledStart,
    // The pool fixes the date the placement falls on; an un-pooled fixture inherits the
    // event's own Slot (ADR-0790).
    window: pool?.slot ?? event.slot,
    suggestedTableIds: pool?.tableIds ?? [],
    placeable:
      fixture.matchStatus === null || !FROZEN_STATUSES.has(fixture.matchStatus),
    tier: fixtureTier(fixture),
    pinnedAt: fixture.pinnedAt,
    callNotifiedCount: fixture.callNotifiedCount,
  }
}

/** Order two matches by predicted start, **unscheduled last**. A placement with no time
 * yet (a half-placed fixture) sorts to the bottom of its table rather than to the top on
 * an empty-string compare. */
function byScheduledStart(a: ScheduleMatch, b: ScheduleMatch): number {
  if (a.scheduledStart === null && b.scheduledStart === null) return 0
  if (a.scheduledStart === null) return 1
  if (b.scheduledStart === null) return -1
  // Order by the absolute instant — the tz-agnostic moment, so two events in
  // different timezones sort by when they actually happen, not by wall-clock.
  const ai = a.scheduledStart.instant
  const bi = b.scheduledStart.instant
  if (ai === bi) return 0
  return ai < bi ? -1 : 1
}

/**
 * Reduce a tournament (+ its table catalogue) to its schedule: every fixture of every
 * event, grouped by the table it is placed on, with the unplaced ones set aside.
 *
 * It **groups and sorts** rather than trusting any order the payload happens to arrive in
 * — order is a claim about untrusted data like any other (the same stance `./draw.ts`
 * takes on rounds).
 */
export function buildSchedule(
  tournament: Tournament,
  catalogue: TournamentTable[],
): TournamentSchedule {
  const tableById = new Map(catalogue.map((t) => [t.id, t]))
  // Catalogue order is the venue's own order (t1, t2, …); a dangling ref sorts after all
  // of it rather than jumping the queue on a string compare.
  const catalogueIndex = new Map(catalogue.map((t, i) => [t.id, i]))

  const matches: ScheduleMatch[] = []
  for (const event of tournament.events) {
    const byId = new Map(event.entrants.map((e) => [e.id, e]))
    const poolById = new Map(event.pools.map((p) => [p.id, p]))
    for (const fixture of event.fixtures) {
      matches.push(toScheduleMatch(fixture, event, byId, poolById))
    }
  }

  const byTable = new Map<string, ScheduleMatch[]>()
  const awaiting: ScheduleMatch[] = []
  for (const match of matches) {
    // A fixture belongs to a table column exactly when it has a table; otherwise it is
    // awaiting placement, whatever its time (a table with no time is still placed).
    if (match.tableId === null) {
      awaiting.push(match)
      continue
    }
    const bucket = byTable.get(match.tableId)
    if (bucket) bucket.push(match)
    else byTable.set(match.tableId, [match])
  }

  const tables: ScheduleTable[] = [...byTable.entries()]
    .map(([tableId, tableMatches]) => ({
      tableId,
      table: tableById.get(tableId) ?? null,
      matches: tableMatches.slice().sort(byScheduledStart),
    }))
    .sort(
      (a, b) =>
        (catalogueIndex.get(a.tableId) ?? Number.MAX_SAFE_INTEGER) -
        (catalogueIndex.get(b.tableId) ?? Number.MAX_SAFE_INTEGER),
    )

  return {
    tables,
    awaiting: awaiting.slice().sort(byScheduledStart),
    isEmpty: matches.length === 0,
  }
}

/** What a schedule match's status reads as, in a director's words (ADR-0790: unplayed vs
 * done). `null` (no match yet) and `pending` (a match reset before it started) both read
 * "Not started"; an `in_progress` match is the ordinary live one — "Unplayed"; a done
 * match says which done. Keyed so a new `MatchStatus` is a compile error until it is
 * given a word, never a blank cell. */
const STATUS_LABEL: Record<MatchStatus, string> = {
  pending: 'Not started',
  in_progress: 'Unplayed',
  completed: 'Completed',
  voided: 'Voided',
}

export function scheduleStatusLabel(match: FixtureMatch | null): string {
  return match === null ? 'Not started' : STATUS_LABEL[match.status]
}

/** The label a side reads as on the schedule — the entrant's username, or the same `TBD`
 * / `Withdrawn` words the draw uses. Used for a control's accessible name (`Place …`), so
 * two rows of one event are told apart by the pairing they name, not by a bare "Place". */
export function sideLabel(side: FixtureSide): string {
  switch (side.kind) {
    case 'entrant':
      return side.name
    case 'tbd':
      return TBD_LABEL
    case 'withdrawn':
      return WITHDRAWN_LABEL
    default: {
      const exhaustive: never = side
      return exhaustive
    }
  }
}

/** The `A vs B` pairing as one string, for a control's accessible name. */
export function matchLabel(match: ScheduleMatch): string {
  return `${sideLabel(match.a)} vs ${sideLabel(match.b)}`
}

/**
 * Compose the naive wall-clock timestamp a placement stores (ADR-0790) from the window's
 * fixed **date** and a chosen **time** (`HH:MM`): `YYYY-MM-DDTHH:MM:SS`, no timezone.
 *
 * This is the whole reason the control only asks for a time: the date is the pool/event
 * Slot's, and the placement lives in the *same naive frame* the Slot does — so this is
 * plain string assembly, never a `Date` (which would drag a timezone in and coerce the
 * wall-clock instant to UTC, the exact thing ADR-0790 refuses).
 */
export function composeScheduledStart(date: string, time: string): string {
  return `${date}T${time}:00`
}

/** The venue-local time formatter (`"6:00 PM CDT"`, ADR "tournament times are
 * timezone-aware instants") lives in `./timeline.ts` (this module already imports from
 * there); re-exported here because the schedule's readers are its natural audience. */
export { fmtFixtureTime }

/**
 * What a placement write would DO to the players, before it is sent (ADR "the schedule
 * is solved; the call is pinned": any placement action that would notify gets a
 * consequence-stating confirm) — the sum type the Schedule tab's submit path branches
 * on. One of:
 *
 * - `silent` — nobody is told: the tournament is not live (free rearranging while
 *   planning), the fixture has a TBD/withdrawn side (a promise to nobody is not a
 *   promise — the server stores the columns, pins nothing, tells nobody), or the
 *   write clears a placement the players were never told about.
 * - `call` — live, both sides known, and the players were never told: placing it
 *   **is** calling it — both players will be notified.
 * - `correction-move` — live, and the players were already told a table/time: moving
 *   it sends both a correction.
 * - `correction-cancel` — live, told, and the write CLEARS the placement: both players
 *   are told the match is off that table.
 */
export type PlacementConsequenceKind =
  | 'silent'
  | 'call'
  | 'correction-move'
  | 'correction-cancel'

/**
 * Judge one placement write — a mirror of the server's own transition
 * (`apply_manual_placement`, `api/app/match_calls.py`), branch for branch:
 *
 * - **Told-ness is `isTold` (`./timeline.ts`)** — `pinnedAt` AND the count, never the
 *   count alone: a call that was later cancelled keeps its count but drops its pin —
 *   re-placing that fixture live is a fresh CALL, not a "moved" correcting a promise
 *   nobody holds.
 * - **Anything less than a full placement is a clear**: a half-placement (a table with
 *   no time) cannot stay promised, so the server unpins it — and, live + told, sends
 *   the cancelled correction. The gate must price that write as the cancel it is.
 * - **A TBD/withdrawn side never notifies**: the columns store softly, no pin, no one
 *   told — silent, whatever the status.
 *
 * Note the pin itself is NOT gated here: every full placement pins, in every status
 * (a director's hand is a commitment). Live only decides whether anyone is *told* —
 * and told is all this confirm prices.
 */
export function placementConsequence(input: {
  tournamentStatus: TournamentStatus
  /** The fixture as it stands — its sides and what its players were already told. */
  match: Pick<ScheduleMatch, 'a' | 'b' | 'pinnedAt' | 'callNotifiedCount'>
  /** The placement the write would store, whole (ADR-0790). */
  write: { tableId: string | null; scheduledStart: string | null }
}): PlacementConsequenceKind {
  if (input.tournamentStatus !== 'live') return 'silent'
  const told = isTold(input.match)
  // The server's clear branch: any half-placement lifts the pin with the columns.
  if (input.write.tableId === null || input.write.scheduledStart === null) {
    return told ? 'correction-cancel' : 'silent'
  }
  // The server's TBD branch: a full placement onto a fixture with no second player
  // stores softly and tells nobody.
  if (input.match.a.kind !== 'entrant' || input.match.b.kind !== 'entrant') {
    return 'silent'
  }
  return told ? 'correction-move' : 'call'
}
