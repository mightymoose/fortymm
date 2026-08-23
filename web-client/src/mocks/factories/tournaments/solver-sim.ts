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
import { mockUuid } from '@/mocks/mock-uuid'

type TournamentFixtureRead = components['schemas']['TournamentFixtureRead']
type ScheduleSolveRead = components['schemas']['ScheduleSolveRead']
type FixtureTimeRead = components['schemas']['FixtureTimeRead']
type Reservation = components['schemas']['Reservation']
/** `GroupRead` widened with `stage_id` (ADR 20260823) AHEAD of `mise run
 * regen-api-types`: the API companion change adding this field lands separately (see
 * `web-client/src/components/tournaments/data/groups.ts`'s own wire schema, hand-
 * maintained the same way for the same reason — `schema.d.ts` is a compile-time claim
 * about a payload the server does not send yet). Drop this intersection once the
 * regenerated `GroupRead` carries `stage_id` itself; it will become a harmless no-op
 * the day it does. */
type Group = components['schemas']['GroupRead'] & { stage_id: string }
type DrawType = components['schemas']['DrawType']

/** A seeded reservation's derived group id — deterministic and stable across reads,
 * because it is a pure function of the reservation's own id rather than a counter
 * (ticket #1369). Lives here, not in either store, because both stores' fixtures name a
 * `group_id` this way and the two worlds must derive the identical id from the identical
 * reservation or their fixtures would point at different groups for the same seed.
 *
 * Still exactly what its name says: the id a GROUP STAGE'S group takes when it maps to
 * a real reservation. `groupsForEvent` below is what decides WHICH groups an event
 * actually has (ADR 20260823) — this stays the pure `reservationId -> id` half of that,
 * unchanged since ticket #1369. */
export function groupIdFor(reservationId: string): string {
  return mockUuid(`tournament-event-group:${reservationId}`)
}

/** The id of a group that has no reservation to key off of — a standalone event's one
 * group when it has booked none (the ADR 20260823 floor), or an `rr-then-ko` event's
 * knockout-stage group (which never keys off a reservation the way a group-stage group
 * does, even when its `position % reservation count` mapping resolves to a real one —
 * see `groupsForEvent`). Keyed on the STAGE, never the reservation: two different
 * groups of the same event can map to the very same reservation at once (the group
 * stage's position-0 group and the knockout stage's own, both via `0 % N`), and they
 * must never collide on id the way keying both off `reservations[0].id` would. */
function structuralGroupIdFor(stageId: string): string {
  return mockUuid(`tournament-event-group:stage:${stageId}`)
}

/** This slice's original 1:1 (ticket #1369, `GroupRead`'s own doc): one group per
 * reservation, at the same position, all belonging to `stageId` (a group stage's own
 * id — `mintStageReads`'s `'s-1'` by default, since every caller of this helper today
 * builds a group stage's own groups). Neither store STORES this — both derive it from
 * `reservations` at read time, so the 1:1 can never drift out of step by itself.
 *
 * Still used directly for an `rr-then-ko` event's GROUP stage (`groupsForEvent`'s own
 * `rr-then-ko` arm, unchanged since before ADR 20260823 — this mock has never modelled
 * the real server's `ceil(field / 5)`, and closing that gap is not this ticket's job,
 * see the ticket's own #1484 comments in `tournaments-store.ts`). Every OTHER stage's
 * group count is decoupled from `reservations.length` entirely — `groupsForEvent`
 * below, never this function, is what a store should call for an event's real groups. */
export function groupsFor(reservations: readonly Reservation[], stageId = 's-1'): Group[] {
  return reservations.map((r, position) => ({
    id: groupIdFor(r.id),
    position,
    reservation_id: r.id,
    stage_id: stageId,
  }))
}

/** The slice of an event `groupsForEvent` needs — both stores' event shapes satisfy it
 * structurally. */
interface SimEventForGroups {
  draw_type: DrawType
  stages: readonly { id: string; position: number }[]
  reservations: readonly Reservation[]
}

/**
 * An event's REAL groups (ADR 20260823, "every stage holds groups"): the one function
 * a store should call to answer "what groups does this event have right now" — on a
 * plain read, and (filtered to one stage) at the cut. Supersedes the old assumption
 * that an event's group count is always `reservations.length`: it is, still, for an
 * `rr-then-ko` event's own GROUP stage (unchanged, see `groupsFor` above), but every
 * other stage this mock ever mints — a standalone event's one stage, and an
 * `rr-then-ko` event's knockout stage — holds exactly ONE group, always, decoupled
 * from the reservation count entirely.
 *
 * Each group still maps `position % reservation count` to a reservation, `null` when
 * the event has none — the one mapping rule ADR 20260822 established and ADR 20260823
 * leaves alone. A knockout stage's sole group sits at `position: 0` within ITS OWN
 * stage, so `0 % N` maps it to `reservations[0]` exactly like the group stage's own
 * position-0 group — the two are expected to share a reservation (ADR 20260823's own
 * "the mapping stays derived" constraint), and it is precisely why they cannot share
 * an id either (`structuralGroupIdFor`).
 *
 * Ordered `[...groupStageGroups, knockoutGroup]` for an `rr-then-ko` event — the group
 * stage's groups first, in position order, then the knockout stage's one group last —
 * which is a convenience for a caller that wants "every group", not a claim about
 * cross-stage order (nothing here ranks a knockout group against a group-stage one).
 */
export function groupsForEvent(event: SimEventForGroups): Group[] {
  const orderedStages = [...event.stages].sort((a, b) => a.position - b.position)
  const reservationCount = event.reservations.length
  const reservationIdAt = (position: number): string | null =>
    reservationCount === 0 ? null : event.reservations[position % reservationCount].id

  if (event.draw_type !== 'rr-then-ko') {
    const stage = orderedStages[0]
    if (!stage) return []
    // Decoupled from the reservation count entirely (the ADR 20260823 floor): always
    // exactly one group, whatever `reservationCount` is. When there IS a reservation,
    // this keeps minting the SAME id `groupsFor` always has (`groupIdFor`), so every
    // existing single-reservation seed and test keeps the group id it already asserts.
    const id =
      reservationCount > 0
        ? groupIdFor(event.reservations[0].id)
        : structuralGroupIdFor(stage.id)
    return [{ id, position: 0, reservation_id: reservationIdAt(0), stage_id: stage.id }]
  }

  const groupStage = orderedStages[0]
  const knockoutStage = orderedStages[1]
  if (!groupStage || !knockoutStage) return []
  // The group stage: UNCHANGED, still one group per reservation (see `groupsFor`'s own
  // doc for why this mock does not attempt `ceil(field / 5)` here).
  const groupStageGroups = groupsFor(event.reservations, groupStage.id)
  // The knockout stage: NEW (ADR 20260823) — exactly one group, always, mapped by the
  // same `position % reservation count` rule, with its own id so it never collides
  // with the group stage's own position-0 group even when both map to
  // `reservations[0]`.
  const knockoutGroup: Group = {
    id: structuralGroupIdFor(knockoutStage.id),
    position: 0,
    reservation_id: reservationIdAt(0),
    stage_id: knockoutStage.id,
  }
  return [...groupStageGroups, knockoutGroup]
}

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
 * structurally, so the functions stay generic over whichever they hold.
 *
 * `reservations`, not `groups` (ticket #1369): a fixture's `group_id` names a group, but
 * a group carries no tables or window of its own — those live on the reservation it maps
 * to 1:1, which is what the placement pass below actually needs. `groupsFor` (above)
 * bridges the two. */
interface SimEvent {
  reservations: Reservation[]
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
    // Always a list; a queued run has reached no infeasibility.
    infeasibility_reasons: [],
    // Always a list; a queued run has placed nothing, so no overlap to report.
    placement_conflicts: [],
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
 * Group A"; the day's own first ball is the only honest clock a mock has. */
export function wallNow(events: readonly SimEvent[], fallback: string): string {
  const starts = placedStarts(events)
  starts.push(fallback)
  return starts.reduce((a, b) => (a < b ? a : b))
}

/** The mock solver's own placement pass: every fixture with no table yet is dealt
 * onto its **group's reservation's** tables — round-robin across them, 30 minutes apart
 * from the reservation window's start — in the same naive wall-clock frame the Slot is
 * in (no `Date`, ADR-0790). Ungrouped fixtures and already-placed ones are left alone: a
 * real solve respects pins, and this mock has nothing smarter to say about a
 * fixture with no window. Returns the placed events plus how many placements were
 * written — what the ledger row reports as `fixtures_placed`. */
export function placeUnplacedFixtures<E extends SimEvent>(
  events: E[],
): { events: E[]; placed: number } {
  let placed = 0
  const next = events.map((event) => {
    // The two-hop lookup this event's own groups derive (`groupIdFor`): a fixture names
    // a GROUP, and a group's tables/window are its mapped RESERVATION's. Keyed straight
    // off each reservation's own derived group id — the loop already holds the
    // reservation, so there is nothing to re-find.
    const reservationByGroupId = new Map(
      event.reservations.map((r) => [groupIdFor(r.id), r]),
    )
    const perReservation = new Map<string, number>()
    const fixtures = event.fixtures.map((fixture) => {
      if (fixture.table_id !== null) return fixture
      const reservation =
        fixture.group_id !== null ? reservationByGroupId.get(fixture.group_id) : undefined
      if (!reservation || reservation.table_ids.length === 0) return fixture
      const index = perReservation.get(reservation.id) ?? 0
      perReservation.set(reservation.id, index + 1)
      const table = reservation.table_ids[index % reservation.table_ids.length]
      const wave = Math.floor(index / reservation.table_ids.length)
      const [hours, minutes] = reservation.slot.start.split(':').map(Number)
      const total = hours * 60 + minutes + wave * 30
      const hh = String(Math.floor(total / 60) % 24).padStart(2, '0')
      const mm = String(total % 60).padStart(2, '0')
      placed += 1
      return {
        ...fixture,
        table_id: table,
        scheduled_start: simFixtureTime(`${reservation.slot.date}T${hh}:${mm}:00`),
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
