// The mock **schedule-solver simulation** (ADR "the schedule is solved; the call
// is pinned") — the pure `events/fixtures in → events/fixtures out` half of the
// two dev-world solver mocks, shared by the MSW store (`src/mocks/tournaments-store.ts`)
// and the web-client-e2e Playwright stub store
// (`e2e/page-objects/tournaments/tournaments-store.ts`), so the two worlds cannot
// drift apart on what a solve DOES. Each store keeps only its own state plumbing
// (the tournaments array / the per-test `detail`, the HTTP answers).
//
// The precedent is `./tournament.factory.ts`: one generated-schema-typed module
// imported by the MSW handlers, the vitest world and the Playwright (Node)
// specs alike — which is why this module must stay dependency-light: schema
// TYPES only, no MSW, nothing that cannot load in a bare Node context.

import type { components } from '@/api/schema'

type TournamentFixtureRead = components['schemas']['TournamentFixtureRead']
type ScheduleSolveRead = components['schemas']['ScheduleSolveRead']
type FixtureTimeRead = components['schemas']['FixtureTimeRead']
type Pool = components['schemas']['Pool']

/** Shape a **naive venue wall-clock** stamp (`YYYY-MM-DDTHH:MM[:SS]`) into the wire
 * `FixtureTimeRead` the server now sends (ADR "tournament times are timezone-aware
 * instants"). The sim works in one venue frame, so it emits the wall-clock AS the UTC
 * `instant` (deterministic tz-agnostic geometry), renders `local_label` as a 12-hour
 * clock, and tags it `CDT`. A duplicate of `buildFixtureTimeRead`
 * (`tournament.factory.ts`) kept here to hold this module dependency-light — schema
 * TYPES only, so it loads in the bare Node context the e2e stub store runs in. */
export function simFixtureTime(naive: string): FixtureTimeRead {
  const [date, time = '00:00'] = naive.split('T')
  const [h = 0, m = 0] = time.split(':').map(Number)
  const hh = String(h).padStart(2, '0')
  const mm = String(m).padStart(2, '0')
  const ampm = h < 12 ? 'AM' : 'PM'
  const h12 = h % 12 || 12
  return {
    instant: `${date}T${hh}:${mm}:00Z`,
    local_label: `${h12}:${mm} ${ampm}`,
    tz_abbrev: 'CDT',
  }
}

/** The naive venue wall-clock a `FixtureTimeRead` carries — the sim's own internal
 * frame. The sim emits the wall-clock as the instant (`simFixtureTime`), so stripping
 * the UTC marker round-trips it back for the sim's plain-string arithmetic. */
function naiveOf(t: FixtureTimeRead): string {
  return t.instant.replace(/Z$/, '')
}

/** The slice of an event the sim reads — both stores' event shapes satisfy it
 * structurally, so the functions stay generic over whichever they hold. */
interface SimEvent {
  pools: Pool[]
  fixtures: TournamentFixtureRead[]
}

/** The server's sentence for a solve on a tournament with no cut draw anywhere,
 * verbatim (`_no_drawn_events_refusal`, `api/app/tournaments.py`). The CODE
 * (`no_drawn_events`) is the contract the client switches on (ADR-0968 shape);
 * this message is its fallback. */
export const NO_DRAWN_EVENTS_MESSAGE =
  'There is nothing to schedule yet: no event of this tournament has a draw. ' +
  "The scheduler places a draw's fixtures onto tables, so cut at least one " +
  "event's draw, then run it."

/** True while a ledger row is on the (simulated) queue or solver — the state in
 * which another POST is absorbed by it and a read walks it forward. A type
 * predicate, so the absorbing store can answer with the row uncast. */
export function solveRowInFlight(
  solve: ScheduleSolveRead | null,
): solve is ScheduleSolveRead & { status: 'queued' | 'running' } {
  return solve !== null && (solve.status === 'queued' || solve.status === 'running')
}

/** A freshly-minted `queued` ledger row: every stage-not-reached field `null`,
 * exactly as the route's 202 answers. */
export function queuedSolveRow(id: string): ScheduleSolveRead {
  return {
    id,
    trigger: 'manual',
    status: 'queued',
    verdict: null,
    requested_at: new Date().toISOString(),
    started_at: null,
    finished_at: null,
    wall_time_ms: null,
    fixtures_placed: null,
    fixtures_pinned: null,
    overrunning: false,
    error: null,
  }
}

/** How long a walked solve dwells on each step, minimum: the client's reconcile
 * can land two detail reads back-to-back (the list key prefix-matches the detail
 * key, so one invalidate refetches it twice), and a step per read would walk
 * `queued` → `succeeded` inside a single reconcile — the "solving…" state the
 * whole loop exists to demo (and the specs watch for) would be unobservable.
 * The dwell puts each step on a DIFFERENT poll. */
export const SOLVE_TICK_DWELL_MS = 600

/** Every placed start in the events, in the sim's naive wall-clock frame. */
function placedStarts(events: readonly SimEvent[]): string[] {
  return events
    .flatMap((e) => e.fixtures)
    .filter((f) => f.table_id !== null && f.scheduled_start !== null)
    .map((f) => naiveOf(f.scheduled_start as FixtureTimeRead))
}

/** The sim's naive "now": the earliest placed `scheduled_start` anywhere — the
 * moment the venue's day opens — `fallback` included (it covers the first
 * placement of the day judging before it lands). The seeds' slots live on fixed
 * calendar dates, so the machine's real clock can never be "10 minutes before
 * Pool A"; the day's own first ball is the only honest clock a mock has. */
export function wallNow(events: readonly SimEvent[], fallback: string): string {
  const starts = placedStarts(events)
  starts.push(fallback)
  return starts.reduce((a, b) => (a < b ? a : b))
}

/** The mock solver's own placement pass: every fixture with no table yet is dealt
 * onto its **pool's** tables — round-robin across them, 30 minutes apart from the
 * pool window's start — in the same naive wall-clock frame the Slot is in (no
 * `Date`, ADR-0790). Un-pooled fixtures and already-placed ones are left alone: a
 * real solve respects pins, and this mock has nothing smarter to say about a
 * fixture with no window. Returns the placed events plus how many placements were
 * written — what the ledger row reports as `fixtures_placed`. */
export function placeUnplacedFixtures<E extends SimEvent>(
  events: E[],
): { events: E[]; placed: number } {
  let placed = 0
  const next = events.map((event) => {
    const poolById = new Map(event.pools.map((p) => [p.id, p]))
    const perPool = new Map<string, number>()
    const fixtures = event.fixtures.map((fixture) => {
      if (fixture.table_id !== null) return fixture
      const pool = fixture.pool_id !== null ? poolById.get(fixture.pool_id) : undefined
      if (!pool || pool.table_ids.length === 0) return fixture
      const index = perPool.get(pool.id) ?? 0
      perPool.set(pool.id, index + 1)
      const table = pool.table_ids[index % pool.table_ids.length]
      const wave = Math.floor(index / pool.table_ids.length)
      const [hours, minutes] = pool.slot.start.split(':').map(Number)
      const total = hours * 60 + minutes + wave * 30
      const hh = String(Math.floor(total / 60) % 24).padStart(2, '0')
      const mm = String(total % 60).padStart(2, '0')
      placed += 1
      return {
        ...fixture,
        table_id: table,
        scheduled_start: simFixtureTime(`${pool.slot.date}T${hh}:${mm}:00`),
      }
    })
    return { ...event, fixtures }
  })
  return { events: next, placed }
}

/** The ADR's call-ahead window, in minutes: a fixture whose projected start is
 * this close gets **called** — pinned and notified — rather than left an
 * estimate. */
const CALL_AHEAD_MIN = 10

/** A naive placement stamp (`YYYY-MM-DDTHH:MM[:SS]`) as its date + minutes past
 * that date's midnight — plain string arithmetic in the venue's own frame, never
 * a `Date` (ADR-0790). */
function stampMinutes(stamp: string): { date: string; minutes: number } {
  const [date, time] = stamp.split('T')
  const [h, m] = (time ?? '').split(':').map(Number)
  return { date, minutes: (h || 0) * 60 + (m || 0) }
}

/** The sim's **calling pass** (ADR "the schedule is solved; the call is
 * pinned"), run by the stores only while the tournament is LIVE: any placed,
 * still-unpinned fixture whose `scheduled_start` falls within the call-ahead
 * window of the sim's "now" (`wallNow`'s clock) gets `pinned_at` set and one
 * notification counted — so the dev loop and the browser specs both see a call:
 * run the scheduler on a live tournament and the imminent bars come back
 * `called`, badge and all. */
export function pinImminentFixtures<E extends SimEvent>(
  events: E[],
): { events: E[]; pinned: number } {
  const starts = placedStarts(events)
  if (starts.length === 0) return { events, pinned: 0 }
  const now = starts.reduce((a, b) => (a < b ? a : b))
  const nowAt = stampMinutes(now)
  let pinned = 0
  const next = events.map((event) => ({
    ...event,
    fixtures: event.fixtures.map((fixture) => {
      // Already promised, unplaced, half-drawn, or DECIDED: nothing to call.
      // An `in_progress` match is NOT skipped — the server calls those too
      // (`_due_for_call` + the settled-match filter, `api/app/match_calls.py`):
      // go-live materializes every round-robin fixture into an `in_progress`
      // match, so "in progress" means scoreable, not under way — its players
      // still need to be told when and where. (This sim used to skip them,
      // which is exactly how the mock worlds stayed green while QA caught the
      // real board hiding every call.)
      if (
        fixture.pinned_at !== null ||
        fixture.table_id === null ||
        fixture.scheduled_start === null ||
        fixture.entry_a_id === null ||
        fixture.entry_b_id === null ||
        fixture.winner_entry_id !== null ||
        fixture.match_status === 'completed' ||
        fixture.match_status === 'voided'
      ) {
        return fixture
      }
      const at = stampMinutes(naiveOf(fixture.scheduled_start))
      const imminent =
        at.date === nowAt.date &&
        at.minutes >= nowAt.minutes &&
        at.minutes - nowAt.minutes <= CALL_AHEAD_MIN
      if (!imminent) return fixture
      pinned += 1
      return { ...fixture, pinned_at: simFixtureTime(now), call_notified_count: 1 }
    }),
  }))
  return { events: next, pinned }
}

/**
 * The manual placement's **pin consequences** — the SERVER's transition table
 * (`apply_manual_placement`, `api/app/match_calls.py`), branch for branch:
 *
 * - **Full placement, both entrants known → the pin, in EVERY status**:
 *   `pinned_at = wallNow(...)`, set or refreshed (a director's hand is a
 *   commitment, pre-live included). Live only gates the *telling*: while live
 *   the placement notifies — called if the players were never told, moved if
 *   they were (count +1 either way).
 * - **Full placement, a TBD side** → the columns store softly (ADR-0790), no
 *   pin, nobody told: a promise to nobody is not a promise.
 * - **Anything less than a full placement → a clear**: the pin (if any) lifts
 *   with the columns, in every status; live + previously TOLD sends the
 *   cancelled correction (count +1) — otherwise silent. The count is never
 *   reset: it is "how many times the players were told".
 *
 * Told-ness is `pinned_at` AND `count > 0`, exactly as the server judges it
 * (and as the client's `isTold` mirrors it).
 */
export function manualPlacementPin<E extends SimEvent>(
  events: readonly E[],
  fixture: Pick<
    TournamentFixtureRead,
    'pinned_at' | 'call_notified_count' | 'entry_a_id' | 'entry_b_id'
  >,
  body: { table_id: string | null; scheduled_start: string | null },
  live: boolean,
): { pinned_at: FixtureTimeRead | null; call_notified_count: number } {
  const wasTold = fixture.pinned_at !== null && fixture.call_notified_count > 0
  let pinned_at = fixture.pinned_at
  let call_notified_count = fixture.call_notified_count
  if (body.table_id === null || body.scheduled_start === null) {
    // The clear: a half-placement cannot stay promised — unpin, every status.
    pinned_at = null
    if (live && wasTold) call_notified_count += 1 // the cancelled correction
  } else if (fixture.entry_a_id === null || fixture.entry_b_id === null) {
    // TBD side: soft write (ADR-0790), pin nothing, tell nobody.
  } else {
    // The pin — set or refreshed, re-dated to the moment the director made it.
    pinned_at = simFixtureTime(wallNow(events, body.scheduled_start))
    if (live) call_notified_count += 1 // called (untold) or moved (told)
  }
  return { pinned_at, call_notified_count }
}

/**
 * One step of the simulated worker, driven by the detail READS (neither mock
 * world has a real queue): `queued` → `running`, then `running` → `succeeded`
 * (verdict `feasible` — the honest mid-tournament answer, a good plan under the
 * time cap) with the placements dealt (`placeUnplacedFixtures`) and, while
 * `live`, the imminent ones called (`pinImminentFixtures`). Returns `null` for a
 * terminal row — a seeded `infeasible`/`failed` strip stays what the seed said.
 *
 * The caller owns the dwell (`SOLVE_TICK_DWELL_MS`) — when the last step
 * happened is store state, like everything else stateful.
 */
export function stepScheduleSolve<E extends SimEvent>(
  solve: ScheduleSolveRead,
  events: E[],
  live: boolean,
): { solve: ScheduleSolveRead; events: E[] } | null {
  if (solve.status === 'queued') {
    return {
      solve: { ...solve, status: 'running', started_at: new Date().toISOString() },
      events,
    }
  }
  if (solve.status === 'running') {
    const dealt = placeUnplacedFixtures(events)
    // Calling rides the apply, and only while LIVE (ADR: pre-live placements
    // are silent pins-to-be — solves plan, notify no one).
    const call = live
      ? pinImminentFixtures(dealt.events)
      : { events: dealt.events, pinned: 0 }
    return {
      solve: {
        ...solve,
        status: 'succeeded',
        verdict: 'feasible',
        finished_at: new Date().toISOString(),
        wall_time_ms: 1200,
        fixtures_placed: dealt.placed,
        fixtures_pinned: call.pinned,
      },
      events: call.events,
    }
  }
  return null
}
