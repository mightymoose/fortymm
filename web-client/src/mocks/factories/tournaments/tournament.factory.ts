import type { components } from '@/api/schema'
import { FORTYMM_LEAGUE_ID } from '@/mocks/factories/players/player-league.factory'
import { groupsFor, simFixtureTime } from '@/mocks/factories/tournaments/solver-sim'
import {
  BAY_AREA_OPEN_ID,
  SUMMER_SLAM_ID,
} from '@/mocks/factories/tournaments/tournament-ids'

type TournamentDetailRead = components['schemas']['TournamentDetailRead']
type DrawType = components['schemas']['DrawType']
type DrawTypeRead = components['schemas']['DrawTypeRead']
type TournamentEventRead = components['schemas']['TournamentEventRead']
type TournamentEntrantRead = components['schemas']['TournamentEntrantRead']
type TournamentFixtureRead = components['schemas']['TournamentFixtureRead']
type EventStageRead = components['schemas']['EventStageRead']
type TournamentTable = components['schemas']['TournamentTable']
type StandingsResultsRead = components['schemas']['StandingsResultsRead']
type FinishesResultsRead = components['schemas']['FinishesResultsRead']
type StandingsThenFinishesResultsRead =
  components['schemas']['StandingsThenFinishesResultsRead']
type FinishRowRead = components['schemas']['FinishRowRead']
type GroupStandingsRead = components['schemas']['GroupStandingsRead']
type StandingRowRead = components['schemas']['StandingRowRead']
type ScheduleSolveRead = components['schemas']['ScheduleSolveRead']
type FixtureTimeRead = components['schemas']['FixtureTimeRead']
type ConflictFixtureRead = components['schemas']['ConflictFixtureRead']
type TableConflictRead = components['schemas']['TableConflictRead']
type PlayerConflictRead = components['schemas']['PlayerConflictRead']
type AdminScheduleSolveRead = components['schemas']['AdminScheduleSolveRead']
type AdminScheduleSolveListResponse =
  components['schemas']['AdminScheduleSolveListResponse']

/** A single physical table, `T1` on court 1. */
export function buildTournamentTable(
  overrides: Partial<TournamentTable> = {},
): TournamentTable {
  return { id: 't1', label: 'T1', court: '1', ...overrides }
}

/** One active entrant, **rated** (1450 on the tournament's ladder). `id` is the
 * ENTRY's id — the address a withdrawal is sent to (`DELETE …/entries/{entry_id}`)
 * — not the player's.
 *
 * `rating: null` is the *unrated* entrant (ADR-0783 §3): the server resolved that
 * this player holds no rating on the tournament's league, so they pass every rating
 * rule and the roster marks them. It is a state a fixture asks for explicitly —
 * rated is the ordinary case. */
export function buildTournamentEntrantRead(
  overrides: Partial<TournamentEntrantRead> = {},
): TournamentEntrantRead {
  return {
    id: 'entry-1',
    user_id: 'u-rita',
    username: 'rita.kovac',
    seed: null,
    rating: 1450,
    ...overrides,
  }
}

/** `count` distinct entrants (`entry-1`/`player.1`, `entry-2`/`player.2`, …) —
 * for the cases that care about how MANY entrants an event has, not who.
 * `overrides` apply to every one of them (e.g. `{ rating: null }` for a roster of
 * uniformly unrated entrants). */
export function buildTournamentEntrantReads(
  count: number,
  overrides: Partial<TournamentEntrantRead> = {},
): TournamentEntrantRead[] {
  return Array.from({ length: count }, (_, i) =>
    buildTournamentEntrantRead({
      id: `entry-${i + 1}`,
      user_id: `u-${i + 1}`,
      username: `player.${i + 1}`,
      ...overrides,
    }),
  )
}

/** One stage of an event's draw (`EventStageRead`, ADR 20260815) — stage 1,
 * `round-robin`, the shape a single-stage round-robin event's own (system-minted)
 * stage has. Pass `draw_type` for the other single-stage kinds, and `id`/`position`
 * for a later stage of a multi-stage event. */
export function buildEventStageRead(
  overrides: Partial<EventStageRead> = {},
): EventStageRead {
  return { id: 's-1', position: 0, draw_type: 'round-robin', ...overrides }
}

/**
 * The stages the system mints for an event of the given `draw_type` (ADR 20260815
 * decision 3) — the wire-shape mirror of `mintStages` in the domain's own
 * `data/seed.factory.ts`, and the two must keep minting the SAME ids for the same draw
 * type, or a component test built off one and an api-layer test built off the other
 * would disagree about which id an `rr-then-ko` event's knockout fixtures name.
 */
export function mintStageReads(drawType: DrawType): EventStageRead[] {
  switch (drawType) {
    case 'round-robin':
    case 'single-elim':
    case 'swiss':
      return [buildEventStageRead({ draw_type: drawType })]
    case 'rr-then-ko':
      return [
        buildEventStageRead({ id: 's-1', position: 0, draw_type: 'round-robin' }),
        buildEventStageRead({ id: 's-2', position: 1, draw_type: 'single-elim' }),
      ]
    default: {
      const exhaustive: never = drawType
      return exhaustive
    }
  }
}

/** One fixture of a cut draw (ADR-0786) — round 1, position 1 of an ungrouped draw,
 * both sides known, undecided and not yet materialized.
 *
 * Every `null` here is a **fact**, and a fixture asks for each one explicitly: a null
 * side is **TBD** (never a bye — a bye is the absence of a fixture row), a null
 * `winner_entry_id` is undecided, a null `match_id` is un-materialized, and a null
 * `group_id` is an ungrouped draw. The defaults are the ordinary case a director sees
 * the morning of: a planned pairing, both players known, nothing played — so
 * `match_status` is `null` too, moving in lockstep with `match_id`. Its **placement**
 * (ADR-0790) starts empty: `table_id` null is unassigned, `scheduled_start` null is
 * unscheduled — and **uncalled**: `pinned_at` null means the placement is still an
 * estimate the solver may move, and `call_notified_count` 0 means nobody has been
 * told anything (ADR "the schedule is solved, the call is pinned"). `completed_at`
 * null means the match has not actually finished yet, distinct from the placement's
 * merely *predicted* `scheduled_start`. */
/** Build a wire `FixtureTimeRead` (ADR "tournament times are timezone-aware
 * instants") from a **naive venue wall-clock** stamp (`YYYY-MM-DDTHH:MM[:SS]`) — the
 * convenient shape a mock/test writes. The mock treats the wall-clock as the UTC
 * `instant` (deterministic geometry across a single-venue seed), renders `local_label`
 * as a 12-hour clock, and tags it `CDT`. Shared with the dev-world solver sim and both
 * store stubs, so all three worlds emit the identical shape the server does. */
export const buildFixtureTimeRead = simFixtureTime

/** A wire fixture time override: the full `FixtureTimeRead`, or the convenient naive
 * wall-clock string (coerced through `buildFixtureTimeRead`), or `null`. */
type FixtureTimeReadInput = FixtureTimeRead | string | null

function coerceFixtureTimeRead(input: FixtureTimeReadInput): FixtureTimeRead | null {
  if (input === null) return null
  return typeof input === 'string' ? buildFixtureTimeRead(input) : input
}

type TournamentFixtureReadOverrides = Partial<
  Omit<TournamentFixtureRead, 'scheduled_start' | 'pinned_at' | 'completed_at'>
> & {
  scheduled_start?: FixtureTimeReadInput
  pinned_at?: FixtureTimeReadInput
  completed_at?: FixtureTimeReadInput
}

export function buildTournamentFixtureRead(
  overrides: TournamentFixtureReadOverrides = {},
): TournamentFixtureRead {
  const { scheduled_start, pinned_at, completed_at, ...rest } = overrides
  return {
    id: 'fx-1',
    // `'s-1'` — `buildEventStageRead`'s own default id, and `mintStageReads`'s id for
    // every single-stage draw type's one stage (ADR 20260815). A fixture of a
    // multi-stage event's second stage (an `rr-then-ko` bracket) overrides this to
    // `'s-2'`, matching `mintStageReads`'s own numbering.
    stage_id: 's-1',
    group_id: null,
    round: 1,
    position: 1,
    entry_a_id: 'entry-1',
    entry_b_id: 'entry-2',
    winner_entry_id: null,
    match_id: null,
    match_status: null,
    table_id: null,
    call_notified_count: 0,
    ...rest,
    // The placement times last, so the naive-string coercion wins over a raw override.
    scheduled_start: coerceFixtureTimeRead(scheduled_start ?? null),
    pinned_at: coerceFixtureTimeRead(pinned_at ?? null),
    completed_at: coerceFixtureTimeRead(completed_at ?? null),
  }
}

/** One row of the tournament's **solve ledger** (`ScheduleSolveRead`, ADR "the
 * schedule is solved, the call is pinned") — by default a *finished, successful*
 * manual run: the owner pressed Run scheduler, the solver proved the plan optimal
 * in under a second, and every one of nine fixtures got a placement.
 *
 * The defaults are internally consistent for the `succeeded` status — every stage
 * reached, so every stage-marking field is set. A fixture that wants an earlier
 * stage overrides the status *and* nulls the fields that stage has not reached
 * (`queued`: everything after `requested_at` null; `failed`: `verdict` and the
 * apply counts null, `error` set) — each `null` is a fact about how far the run
 * got, not a missing field. */
export function buildScheduleSolveRead(
  overrides: Partial<ScheduleSolveRead> = {},
): ScheduleSolveRead {
  return {
    id: 'solve-1',
    trigger: 'manual',
    status: 'succeeded',
    verdict: 'optimal',
    requested_at: '2026-06-13T09:00:00Z',
    started_at: '2026-06-13T09:00:01Z',
    finished_at: '2026-06-13T09:00:02Z',
    wall_time_ms: 850,
    fixtures_placed: 9,
    fixtures_pinned: 0,
    overrunning: false,
    error: null,
    // A succeeded run has no infeasibility reasons; the field is always a list
    // (`[]` off the infeasible path). An infeasible fixture that wants the
    // specific dated message overrides `infeasibility_reasons: [{ kind:
    // 'past_window', date }]`.
    infeasibility_reasons: [],
    // A clean board has no overlapping in-progress matches; the field is always a
    // list (`[]` on a clean board) and orthogonal to the verdict — a fixture
    // proving the caution passes `placement_conflicts` on ANY status.
    placement_conflicts: [],
    ...overrides,
  }
}

/** One in-progress match caught in a placement conflict, on the wire — named by
 * its matchup (`crafty` vs `spiked`, resolved usernames), the raw `fixture_id`
 * riding along. */
export function buildConflictFixtureRead(
  overrides: Partial<ConflictFixtureRead> = {},
): ConflictFixtureRead {
  return {
    fixture_id: 'fx-conflict-a',
    player_a: 'crafty',
    player_b: 'spiked',
    ...overrides,
  }
}

/** A **table** placement conflict on the wire (ADR "overlapping-in-progress-
 * matches-are-tolerated-and-reported"): two in-progress matches recorded on the
 * same table (`Table 1`). */
export function buildTableConflictRead(
  overrides: Partial<TableConflictRead> = {},
): TableConflictRead {
  return {
    kind: 'table_conflict',
    table_label: 'Table 1',
    fixtures: [
      buildConflictFixtureRead({ fixture_id: 'fx-conflict-a', player_a: 'crafty', player_b: 'spiked' }),
      buildConflictFixtureRead({ fixture_id: 'fx-conflict-b', player_a: 'dazed', player_b: 'confused' }),
    ],
    ...overrides,
  }
}

/** A **player** placement conflict on the wire: two in-progress matches sharing a
 * human (`spiked-frigatebird`). */
export function buildPlayerConflictRead(
  overrides: Partial<PlayerConflictRead> = {},
): PlayerConflictRead {
  return {
    kind: 'player_conflict',
    player_name: 'spiked-frigatebird',
    fixtures: [
      buildConflictFixtureRead({
        fixture_id: 'fx-conflict-c',
        player_a: 'crafty',
        player_b: 'spiked-frigatebird',
      }),
      buildConflictFixtureRead({
        fixture_id: 'fx-conflict-d',
        player_a: 'spiked-frigatebird',
        player_b: 'nimble',
      }),
    ],
    ...overrides,
  }
}

/** One row of the **admin** solve ledger (`AdminScheduleSolveRead`, the
 * cross-tournament read backing `/admin/schedule-solves`): every field of
 * `buildScheduleSolveRead`, plus the operator-only facts the tournament-facing
 * read omits — the drift guard's `input_fingerprint` (`null` = the run never
 * snapshotted), the coalescer's `rerun_requested` (a trigger landed while this
 * run was `running`; always `false` on terminal rows), and the owning
 * tournament's id + live name. */
export function buildAdminScheduleSolveRead(
  overrides: Partial<AdminScheduleSolveRead> = {},
): AdminScheduleSolveRead {
  return {
    ...buildScheduleSolveRead(),
    input_fingerprint:
      'a3f1c2e94b7d80561e2f9c4a7d3b8e05a3f1c2e94b7d80561e2f9c4a7d3b8e05',
    rerun_requested: false,
    tournament_id: 'bay-area-open-2026',
    tournament_name: 'Bay Area Open 2026',
    ...overrides,
  }
}

/**
 * Page a full admin solve ledger the way `/v1/admin/schedule-solves` does:
 * `tournament_id` narrows, `total` counts the rows matching that same filter,
 * and the slice is `page`/`page_size`. It does **not** re-sort — the API's
 * newest-first ordering is the seed's job, exactly as it is the database's.
 *
 * Shared by the dev-world MSW handler, the vitest page object and the e2e
 * `page.route` stub, so all three worlds answer the page's query params with
 * one implementation instead of three drifting ones.
 */
export function pageAdminScheduleSolves(
  rows: AdminScheduleSolveRead[],
  params: { tournament_id?: string | null; page?: number; page_size?: number },
): AdminScheduleSolveListResponse {
  const page = params.page ?? 1
  const pageSize = params.page_size ?? 25
  const filtered = params.tournament_id
    ? rows.filter((r) => r.tournament_id === params.tournament_id)
    : rows
  return {
    items: filtered.slice((page - 1) * pageSize, page * pageSize),
    page,
    page_size: pageSize,
    total: filtered.length,
  }
}

/**
 * The dev world's solve ledger — enough rows (34) that page 1 truncates at 25
 * (small fixtures hide acceptance bugs), spread over the seeded tournaments so
 * the Tournament links land on detail pages that exist under `npm run dev`,
 * with every terminal shape visible on page 1: succeeded (optimal *and*
 * feasible), infeasible, failed (with the server's error sentence), a run
 * still `running` with a re-run already coalesced onto it, and one `queued`.
 * Newest request first, exactly as the API orders it.
 */
export function buildAdminSolveLedgerSeed(): AdminScheduleSolveRead[] {
  const tournaments = [
    { id: BAY_AREA_OPEN_ID, name: 'Bay Area Open 2026' },
    { id: SUMMER_SLAM_ID, name: 'Summer Slam 2026' },
  ] as const
  // Newest first: minute 59 down to 26.
  const runs = Array.from({ length: 34 }, (_, i) => {
    const t = tournaments[i % tournaments.length]
    const minute = String(59 - i).padStart(2, '0')
    return buildAdminScheduleSolveRead({
      id: `admin-solve-${i + 1}`,
      trigger: (['match_completed', 'manual', 'settings_changed', 'pin_tick'] as const)[
        i % 4
      ],
      requested_at: `2026-07-15T10:${minute}:00Z`,
      started_at: `2026-07-15T10:${minute}:01Z`,
      finished_at: `2026-07-15T10:${minute}:03Z`,
      tournament_id: t.id,
      tournament_name: t.name,
    })
  })
  // Carve the interesting shapes into the newest rows so they sit on page 1.
  runs[0] = {
    ...runs[0],
    status: 'queued',
    verdict: null,
    started_at: null,
    finished_at: null,
    wall_time_ms: null,
    fixtures_placed: null,
    fixtures_pinned: null,
  }
  runs[1] = {
    ...runs[1],
    status: 'running',
    verdict: null,
    finished_at: null,
    wall_time_ms: null,
    fixtures_placed: null,
    fixtures_pinned: null,
    rerun_requested: true,
  }
  runs[2] = {
    ...runs[2],
    status: 'failed',
    verdict: null,
    wall_time_ms: null,
    fixtures_placed: null,
    fixtures_pinned: null,
    error: 'worker crashed: out of memory in CP-SAT presolve',
  }
  runs[3] = {
    ...runs[3],
    status: 'infeasible',
    verdict: 'infeasible',
    fixtures_placed: null,
    fixtures_pinned: null,
  }
  runs[4] = { ...runs[4], verdict: 'feasible', wall_time_ms: 2400 }
  return runs
}

/** The **snake** (`api/app/draws.py`): which entrants each group is dealt, row by row
 * across the groups and reversing every other row, so the top seeds land one per group
 * and group sizes differ by at most one. Returns one member list per group, in
 * `groupIds` order, each preserving draw order.
 *
 * ONE declaration of the arithmetic, because two callers want two different things from
 * it and used to compute it twice: `planRoundRobinFixtures` below wants the *members* to
 * pair, and `planDraw`'s round-robin refusal wants the *sizes* — and that refusal is
 * asked of the groups the snake actually produced, never of arithmetic on N and P,
 * because it is the dealt group that would have a lone entrant in it. */
function snakedGroups(
  entryIds: readonly string[],
  groupCount: number,
): string[][] {
  const groups: string[][] = Array.from({ length: groupCount }, () => [])
  entryIds.forEach((entryId, index) => {
    const row = Math.floor(index / groupCount)
    const offset = index % groupCount
    const column = row % 2 === 0 ? offset : groupCount - 1 - offset
    groups[column].push(entryId)
  })
  return groups
}

/**
 * Plan a **round-robin** draw the way the API plans one (`api/app/draws.py`): snake the
 * ordered entrants across the groups, then pair each group by the circle method — every
 * pair meets once, nobody plays twice in a round.
 *
 * The mock's planner is faithful rather than convenient on purpose. A stub that dealt
 * the field into groups any old way would still *look* like a draw on screen, and the
 * page built against it would be a page built against a shape the server never sends —
 * the fixture count, the rounds, and which two names share a row would all be fiction.
 * The rules it mirrors, each of which is visible on the card:
 *
 * - **Snake, not blocks** — group A takes seeds 1, 2P, 2P+1, …; group B takes 2, 2P−1, …
 *   — so the top seeds land one per group and group sizes differ by at most one.
 * - **A bye is the ABSENCE of a fixture.** An odd group gets a phantom seat; whoever
 *   draws it that round simply has no fixture. There is no `is_bye`, and no null side.
 * - **`position` is contiguous within a (group, round)** — 1..k — because the phantom's
 *   pairing is never emitted.
 *
 * Returns fixtures in group → round → position order, as the wire does.
 *
 * ⚠️ It does **not** enforce the API's refusals (no groups, a group of fewer than two).
 * Those are the *store's* to refuse (`cutDraw`, `tournaments-store.ts`), because they
 * are answers to a request, not shapes of a payload. Handed a degenerate field this
 * plans what it is asked for — which is why nothing but the store should call it.
 */
export function planRoundRobinFixtures(
  entryIds: readonly string[],
  groupIds: readonly string[],
  /** The group stage's own id (ADR 20260815) — `'s-1'` by default, `mintStageReads`'s id
   * for a round-robin event's one stage, and the group stage's own id (position 0) of an
   * `rr-then-ko` event's two. */
  stageId = 's-1',
): TournamentFixtureRead[] {
  const fixtures: TournamentFixtureRead[] = []
  let counter = 0
  const dealt = snakedGroups(entryIds, groupIds.length)

  for (const [groupIndex, groupId] of groupIds.entries()) {
    // The snake (`snakedGroups` above): row-by-row across the groups, reversing every
    // other row.
    const members = dealt[groupIndex]

    // The circle method: pin the first seat, rotate the rest one step per round, and
    // pair across the circle. An odd group gets a phantom (`null`) seat — the entrant
    // drawn against it sits that round out, and no fixture is emitted for them.
    const circle: (string | null)[] = [...members]
    if (circle.length % 2 === 1) circle.push(null)
    const seats = circle.length

    for (let round = 1; round < seats; round += 1) {
      let position = 0
      for (let seat = 0; seat < seats / 2; seat += 1) {
        const home = circle[seat]
        const away = circle[seats - 1 - seat]
        if (home === null || away === null) continue
        position += 1
        counter += 1
        fixtures.push(
          buildTournamentFixtureRead({
            id: `fx-${groupId}-${counter}`,
            stage_id: stageId,
            group_id: groupId,
            round,
            position,
            entry_a_id: home,
            entry_b_id: away,
          }),
        )
      }
      circle.splice(1, 0, circle.pop() as string | null)
    }
  }

  return fixtures
}

/**
 * The **standard single-elimination seeding order** for a bracket of `bracketSize` slots
 * (a power of two): the 1-based seed positions top to bottom, so pairing the adjacent
 * slots — (1st, 2nd), (3rd, 4th), … — gives round 1 and the top two seeds can only meet
 * in the final.
 *
 * The API's `_seed_slots` (`api/app/draws.py`), transcribed: the classic recursion
 * `[1, 2] → [1, 4, 3, 2] → [1, 8, 5, 4, 3, 6, 7, 2] → …`, each step replacing every slot
 * `s` with the pair `(s, total − s)` where `total = 2·len + 1`. Strong-first on even
 * indices and strong-second on odd, which threads the sequence into the familiar
 * `1, 8, 5, 4, …` bracket order rather than a mirror of it.
 *
 * A pure function of seed *positions* — it never sees an entry id.
 */
function seedSlots(bracketSize: number): number[] {
  let slots = [1]
  while (slots.length < bracketSize) {
    const total = 2 * slots.length + 1
    const expanded: number[] = []
    slots.forEach((seed, index) => {
      const pair = index % 2 === 0 ? [seed, total - seed] : [total - seed, seed]
      expanded.push(...pair)
    })
    slots = expanded
  }
  return slots
}

/** One seat in a bracket: where a seed **enters** it. */
interface KnockoutSeat {
  round: number
  position: number
  side: 'a' | 'b'
}

/** Which side of which next-round slot the winner of `(round, position)` goes to:
 * slot `ceil(position / 2)`, side `a` for an odd `position` else `b` (`_successor`,
 * `api/app/draws.py`).
 *
 * The whole of single-elimination's topology, kept as **arithmetic on the coordinates**
 * rather than a stored `next_slot_id` (ADR-0786) — which is also what lets a byed seed be
 * seated by the very same sum that will later seat a winner, so the two cannot disagree.
 */
function successorSlot(position: number): { position: number; side: 'a' | 'b' } {
  return { position: Math.ceil(position / 2), side: position % 2 === 1 ? 'a' : 'b' }
}

/**
 * Where every seed **enters** the bracket that holds `fieldSize` of them:
 * `seed → (round, position, side)` (`_knockout_seats`, `api/app/draws.py`).
 *
 * ONE description of a bracket's shape, for the two questions that need it: *which
 * fixtures exist* (`planKnockoutFixtures` below) and *where does a given seed sit*.
 *
 * Byes are the top `B − fieldSize` seeds, and a byed seed's entry point is its
 * **round-2** side — computed from the round-1 position it would have played, so a bye
 * and a played feeder land on the two sides of the same successor.
 */
function knockoutSeats(fieldSize: number): Map<number, KnockoutSeat> {
  let bracket = 1
  while (bracket < fieldSize) bracket <<= 1
  const slots = seedSlots(bracket)

  const seats = new Map<number, KnockoutSeat>()
  for (let pairIndex = 0; pairIndex < bracket / 2; pairIndex += 1) {
    const position = pairIndex + 1
    const first = slots[2 * pairIndex]
    const second = slots[2 * pairIndex + 1]
    const top = Math.min(first, second)
    const bottom = Math.max(first, second)
    if (bottom <= fieldSize) {
      // Two real seeds: a genuine round-1 match. The top seat is `entry_a` for
      // readability only — the successor side is decided by `position`, not by which
      // seed is `a`.
      seats.set(top, { round: 1, position, side: 'a' })
      seats.set(bottom, { round: 1, position, side: 'b' })
    } else {
      // One phantom (`bottom` > N; two phantoms cannot happen when `bracket` is the
      // SMALLEST power of two ≥ N). The real `top` seed byes straight into round 2.
      const successor = successorSlot(position)
      seats.set(top, { round: 2, ...successor })
    }
  }
  return seats
}

/**
 * The whole ungrouped bracket for `fieldSize` seeds, with each seed's entry taken from
 * `entryForSeed` — **or left TBD for every seed the map does not name**
 * (`_knockout_fixtures`, `api/app/draws.py`).
 *
 * **Two callers, one bracket**, exactly as on the server. `planSingleElimFixtures`
 * passes the full seed → entry map, because a single-elim cut knows its field;
 * `planDraw`'s `rr-then-ko` arm passes an **empty** one, because its qualifiers have not
 * played yet — and gets the identical shape with every side `null`. That the shape is a
 * pure function of `fieldSize` is exactly why a groups-then-knockout bracket can be cut
 * in the same stroke as its groups (ADR "rr-then-ko cuts both stages upfront"): the
 * qualifier count `P × K` is known at cut time, so *which* slots exist and *which* seeds
 * bye is settled before anybody has played.
 *
 * The rules it mirrors, each visible on the bracket:
 *
 * - **A bye is the ABSENCE of a round-1 fixture** (ADR-0786), never a row with a `null`
 *   side. The `B − N` byes fall on the top `B − N` seeds — a slot drawn against a phantom
 *   seat past `N` — and the byed seed is seated *directly onto its round-2 side* at cut
 *   time. So a five-entrant field has **one** round-1 fixture, not four with three empty
 *   halves.
 * - **`null` means TBD, and only TBD**: a later round whose feeder has not been played.
 *   Three round-2 shapes therefore exist at the cut — both feeders played (both sides
 *   null), one bye + one feeder (one side pre-filled), and both feeders byes (a
 *   fully-known fixture that materializes at go-live like any other).
 * - **`position` is the FULL-bracket slot index**, 1-based, never a contiguous
 *   renumbering of the surviving matches: it is what makes the successor arithmetic feed
 *   the right next-round slot, and a byed round-1 slot simply leaves a gap in it.
 * - **`group_id` is null throughout** — a bracket is ungrouped; the event's groups (if
 *   any) are irrelevant to it, exactly as on the server. For an `rr-then-ko` draw that is
 *   not cosmetic: `group_id IS NULL` **is** the knockout stage, and it is what routes
 *   these fixtures to the bracket view rather than into a group's list.
 * - **Rounds are numbered from 1 for both callers.** For a knockout stage that is a
 *   *restart*, not a continuation of the group rounds (ADR): groups may differ in size,
 *   so "the round after the groups" is ill-defined, and restarting is what lets the
 *   client's bracket — which names rounds relative to the maximum it is handed — say
 *   "Final / Semifinals" with no change at all.
 *
 * `idPrefix` distinguishes the two callers' fixture ids, so a mixed event's group and
 * knockout rows never collide. Returns fixtures in round → position order, as the wire
 * does.
 */
function planKnockoutFixtures(
  fieldSize: number,
  entryForSeed: ReadonlyMap<number, string>,
  idPrefix: string,
  /** This bracket's own stage id (ADR 20260815) — `'s-1'` for a plain single-elim
   * event's one stage, `'s-2'` for an `rr-then-ko` event's knockout stage
   * (`mintStageReads`'s numbering). */
  stageId = 's-1',
): TournamentFixtureRead[] {
  // `bracket` = the smallest power of two ≥ the field; `rounds` = its depth (log2).
  let bracket = 1
  while (bracket < fieldSize) bracket <<= 1
  const rounds = Math.log2(bracket)
  const seats = knockoutSeats(fieldSize)

  /** The sides a seed is known to occupy at cut time, keyed `round:position:side`. A
   * seed the caller cannot name yet contributes nothing, so its side stays TBD. */
  const seated = new Map<string, string>()
  for (const [seed, seat] of seats) {
    const entryId = entryForSeed.get(seed)
    if (entryId !== undefined) {
      seated.set(`${seat.round}:${seat.position}:${seat.side}`, entryId)
    }
  }
  const sideOf = (round: number, position: number, side: 'a' | 'b') =>
    seated.get(`${round}:${position}:${side}`) ?? null

  const slot = (round: number, position: number) =>
    buildTournamentFixtureRead({
      id: `${idPrefix}-r${round}-p${position}`,
      stage_id: stageId,
      group_id: null,
      round,
      position,
      entry_a_id: sideOf(round, position, 'a'),
      entry_b_id: sideOf(round, position, 'b'),
    })

  // Only the round-1 positions a bye did NOT empty — that absence IS the bye, so the
  // position sequence simply has gaps in it.
  const roundOnePositions = [
    ...new Set(
      [...seats.values()].filter((s) => s.round === 1).map((s) => s.position),
    ),
  ].sort((a, b) => a - b)

  const fixtures = roundOnePositions.map((position) => slot(1, position))
  if (rounds >= 2) {
    for (let position = 1; position <= bracket / 4; position += 1) {
      fixtures.push(slot(2, position))
    }
  }
  for (let round = 3; round <= rounds; round += 1) {
    for (let position = 1; position <= bracket >> round; position += 1) {
      fixtures.push(slot(round, position))
    }
  }
  return fixtures
}

/**
 * Plan a **single-elimination** draw the way the API plans one
 * (`SingleElimStrategy.plan_initial`, `api/app/draws.py`): pad the field to the next
 * power of two, lay the seeds in by the standard recursive seeding, and emit every later
 * round up front with its sides TBD.
 *
 * `entryIds` arrive in **draw order** (seed ascending, then registration order), so the
 * entrant at index `k` is seed `k + 1` — the position the bracket is laid out by. The
 * shape itself is `planKnockoutFixtures` above; all this arm adds is "seed `k + 1` is
 * this entrant", which is precisely what an `rr-then-ko` cut cannot say yet.
 *
 * ⚠️ Like the round-robin planner it does **not** enforce the API's refusal (a field of
 * fewer than two). That is the *store's* to make, because it is an answer to a request
 * rather than a shape of a payload — which is why nothing but the store should call this.
 */
export function planSingleElimFixtures(
  entryIds: readonly string[],
  /** This bracket's own stage id (ADR 20260815) — see `planKnockoutFixtures`. */
  stageId = 's-1',
): TournamentFixtureRead[] {
  return planKnockoutFixtures(
    entryIds.length,
    new Map(entryIds.map((entryId, index) => [index + 1, entryId])),
    'fx-se',
    stageId,
  )
}

/**
 * The most rounds a field of `size` can play **without a rematch** — the API's
 * `_max_rematch_free_rounds` (`api/app/draws.py`), mirrored here because this stub raises
 * the same refusal the server does.
 *
 * It is **not** `n - 1`, the number of distinct opponents an entrant has. An odd field byes
 * one entrant a round, so over `n` rounds everybody plays `n - 1` matches and sits out
 * once: five entrants really can play five rounds, and refusing that refused a legal swiss.
 * `n - 1 + n % 2` is the same statement in one expression — unchanged for an even field,
 * one round longer for an odd one.
 */
function maxRematchFreeRounds(size: number): number {
  return size - 1 + (size % 2)
}

/**
 * Plan a **swiss** draw the way the API plans one (`SwissStrategy.plan_initial`,
 * `api/app/draws.py`): all `R` rounds up front, `⌊n/2⌋` fixtures each, round 1 seeded
 * top-half-against-bottom-half from the draw order and every later round written with both
 * sides TBD.
 *
 * That "later rounds with no players" shape is not a stub — it is the format (ADR "swiss
 * pre-cuts every round and pairs each one on advance"): with the field frozen at the cut
 * and `R` an explicit setting, the *number* of fixtures is fully determined and only the
 * *sides* are unknown, which is the one thing `advance()` has always handled. So the mock
 * cuts exactly what the server cuts, including the empty rounds a director will see.
 *
 * Fixtures are **ungrouped** (`group_id: null`): swiss ranks the whole field in one table.
 * An odd field byes the **lowest**-ranked entrant, who simply has no fixture — a bye is the
 * absence of a row (ADR-0786), never a row with a null side.
 *
 * `entryIds` arrive in **draw order** (seed ascending, then registration order). Like the
 * other planners it does **not** enforce the API's refusals; those are `planDraw`'s.
 */
export function planSwissFixtures(
  entryIds: readonly string[],
  rounds: number,
  /** This swiss event's own (sole) stage id (ADR 20260815) — `'s-1'`,
   * `mintStageReads`'s id for a swiss event's one stage. */
  stageId = 's-1',
): TournamentFixtureRead[] {
  // The odd entrant out sits the round, so every round holds ⌊n/2⌋ fixtures whatever the
  // parity.
  const pairsPerRound = Math.floor(entryIds.length / 2)
  const fixtures: TournamentFixtureRead[] = []
  for (let round = 1; round <= rounds; round += 1) {
    for (let position = 1; position <= pairsPerRound; position += 1) {
      fixtures.push(
        buildTournamentFixtureRead({
          id: `fx-sw-r${round}-p${position}`,
          stage_id: stageId,
          group_id: null,
          round,
          position,
          // Round 1 alone is paired at the cut: draw-order index `i` meets index
          // `i + pairsPerRound`, so the top seed meets the best of the bottom half. Every
          // later round is genuinely TBD until `advance()` pairs it from the standings.
          entry_a_id: round === 1 ? entryIds[position - 1] : null,
          entry_b_id: round === 1 ? entryIds[position - 1 + pairsPerRound] : null,
        }),
      )
    }
  }
  return fixtures
}

/** A planned draw, or the server's sentence for why this event cannot be cut as it
 * stands. ONE value for both, because they are the same decision: split in two, a
 * refusal check could answer "nothing wrong here" for a shape the planner then has
 * nothing to deal for. */
export type DrawPlan =
  | { ok: true; fixtures: TournamentFixtureRead[] }
  | { ok: false; detail: string }

/** Why the **group stage** cannot be dealt as the event stands, or `null` — the two
 * refusals `_snake` itself raises (`api/app/draws.py`), in its own words.
 *
 * Shared by both grouped arms of `planDraw` below because on the server they are
 * literally the same call: `RrThenKoStrategy.plan_initial` runs `_snake` before it does
 * anything else, so an `rr-then-ko` event with no groups is refused with the sentence
 * about a *round-robin* draw. That reads oddly and is nonetheless right — the group
 * stage of an rr-then-ko draw **is** a round-robin — and inventing a second wording here
 * would put a sentence in the server's mouth it never says.
 *
 * Asked of the DEALT groups, not of arithmetic on N and P: the refusal is about the
 * groups the snake actually produced, and it names the numbers the director must change.
 *
 * **Both nouns are inflected**, exactly as `_snake` inflects them: "1 entrant across 1
 * group", "5 entrants across 3 groups". This used to read `group(s)` and to say "1
 * entrants", which is a sentence the server has never said — harmless-looking until #1300
 * put the one-entrant round-robin case into the GO-LIVE refusal, where the mock's sentence
 * and the API's are asserted against the same literal. */
function snakeRefusal(
  entryIds: readonly string[],
  groupIds: readonly string[],
): string | null {
  if (groupIds.length === 0) return 'A round-robin draw needs at least one group.'
  if (snakedGroups(entryIds, groupIds.length).some((group) => group.length < 2)) {
    const entrantNoun = entryIds.length === 1 ? 'entrant' : 'entrants'
    const groupNoun = groupIds.length === 1 ? 'group' : 'groups'
    return (
      `${entryIds.length} ${entrantNoun} across ${groupIds.length} ${groupNoun} would ` +
      'leave a group with fewer than 2 entrants, who would have nobody to play.'
    )
  }
  return null
}

/**
 * Plan an event's draw exactly as the cut route does, or say why it cannot be — the
 * planner's 422s, in the server's own words (`app/draws.py`), because for these the
 * sentence IS the answer: it names the thing the director has to change.
 *
 * **One implementation for both stubs.** The MSW store (`src/mocks/tournaments-store.ts`)
 * and the Playwright store (`e2e/page-objects/tournaments/tournaments-store.ts`) mirror
 * each other on purpose, but this decision — which refusals exist, and the three
 * server-authored sentences that carry them — is not a thing for them to mirror: two
 * copies is two chances for a spec to be green against words the API never says. Each
 * store still owns its own entrant ordering (it reads its own row shape) and hands the
 * result in.
 *
 * `entryIds` arrive in **draw order** — seed ascending where one is set, then
 * registration order (ADR-0786) — because that is the list the API's planner is handed.
 *
 * **`qualifiersPerGroup` has no default**, on purpose. It is a real column
 * (`tournament_event_draw_settings.qualifiers_per_group`) that rides both write bodies and
 * comes back on `TournamentEventRead`, so every caller genuinely has an answer: a stored
 * event's own value, or `null` for the three draw types that take no count. A default here
 * would let one be omitted by accident, and that is the quietest possible mock/server
 * disagreement — a K=1 bracket cut for an event configured at K=2 raises nothing, is a
 * perfectly well-formed draw, and is simply the wrong size.
 *
 * **Exhaustive over `DrawType`, with no default arm.** Every member of the enum has a
 * server-side strategy by construction (ADR 20260726), so there is no "this type cannot
 * be cut" refusal left to make — and adding a member tomorrow is a *type error* here
 * until it is given a planner, rather than a stub that quietly refuses a draw the server
 * would have dealt. Living in `src`, this `switch` is genuinely checked by `tsc -b`;
 * the copy that used to sit in `e2e/` was not (`tsconfig.app.json` covers only `src`),
 * which is the other reason there is one of these now.
 */
export function planDraw(
  drawType: DrawType,
  entryIds: readonly string[],
  groupIds: readonly string[],
  /** **K** — how many of each group's finishers advance into an `rr-then-ko` draw's
   * knockout stage. `null` for the three draw types that have no knockout stage to qualify
   * for, which is what their settings row holds and what their callers pass out loud. */
  qualifiersPerGroup: number | null,
  /** **R** — how many rounds a `swiss` draw plays. `null` for the three draw types whose
   * round count nobody chooses, which is what their settings row holds and what their
   * callers pass out loud. Same discipline as `qualifiersPerGroup` above: no default, so
   * every caller has to answer where R comes from. */
  rounds: number | null,
  /** This event's own **stages** (ADR 20260815) — `event.stages` itself, id and
   * `position` (the wire's `EventStageRead` satisfies this structurally, extra fields
   * and all), so the fixtures this cuts name the SAME stage rows the event holds. Indexed
   * internally by `position` rather than taken as a fixed-arity tuple, so a caller with an
   * actual event just hands its `stages` array through — no synthesizing a second slot for
   * a single-stage event. Defaults to `mintStageReads(drawType)`, the template for THIS
   * draw type, so the many call sites that plan a draw without an event to read stages off
   * of (this module's own tests among them) still cut a self-consistent shape. A
   * single-stage draw type reads only the position-0 stage; `rr-then-ko` reads both — the
   * group stage at position 0 and the knockout stage at position 1. */
  stages: readonly { id: string; position: number }[] = mintStageReads(drawType),
): DrawPlan {
  const orderedStages = [...stages].sort((a, b) => a.position - b.position)
  const firstStage = orderedStages[0]
  if (!firstStage) {
    throw new Error('planDraw: no stages to cut this draw against.')
  }
  // The position-0 stage: a round-robin/rr-then-ko draw's group stage, or the ONE stage a
  // single-elim/swiss draw has (which is a "group" stage in name only — those draw types
  // have no groups).
  const firstStageId = firstStage.id
  // The position-1 stage: only `rr-then-ko` has one, and only its own arm below reads
  // this. The `?? firstStageId` fallback just keeps the value defined for the other three
  // arms, which never read it — no real `rr-then-ko` event can reach here with fewer than
  // two stages (`mintStageReads('rr-then-ko')` always mints both).
  const knockoutStageId = orderedStages[1]?.id ?? firstStageId
  switch (drawType) {
    case 'round-robin': {
      const refusal = snakeRefusal(entryIds, groupIds)
      if (refusal !== null) return { ok: false, detail: refusal }
      return {
        ok: true,
        fixtures: planRoundRobinFixtures(entryIds, groupIds, firstStageId),
      }
    }
    case 'single-elim': {
      // Round-robin's per-group floor, one level up: a bracket of one has no fixtures and
      // is not a competition. The event's GROUPS are not consulted at all — a bracket is
      // ungrouped, so a single-elim event with groups cuts perfectly well and a
      // single-elim event with none is not refused, exactly as on the server.
      if (entryIds.length < 2) {
        return {
          ok: false,
          detail:
            'A single-elimination draw needs at least 2 entrants — a bracket of ' +
            'one has nobody to play.',
        }
      }
      // A single-elim event's ONE stage is `firstStageId` — a plain bracket event has no
      // group stage at all, and its one stage still mints at `mintStageReads`'s `'s-1'`.
      return { ok: true, fixtures: planSingleElimFixtures(entryIds, firstStageId) }
    }
    case 'rr-then-ko': {
      // BOTH STAGES IN ONE STROKE (ADR "rr-then-ko cuts both stages upfront and seeds
      // qualifiers rematch-free"): the group fixtures *and* the whole bracket, the latter
      // entirely TBD-sided. Not a convenience — `advance()` can only ever FILL a side of
      // an existing fixture, never create one, so a bracket that did not exist at the cut
      // could never come into being.
      //
      // The refusals, in the server's order (`RrThenKoStrategy.plan_initial`): the
      // snake's two first, because the group stage is dealt before the qualifier count is
      // consulted at all.
      const refusal = snakeRefusal(entryIds, groupIds)
      if (refusal !== null) return { ok: false, detail: refusal }
      if (qualifiersPerGroup === null) {
        // NOT a refusal, and NOT a default: an `rr-then-ko` event without a count is not
        // a state the server can be in — the write boundary requires one with no default
        // (`RrThenKoDrawSettingsWrite`), so the column is never NULL for this draw type.
        // A stub reaching here has been seeded or patched into a shape the API cannot
        // hold, and says so instead of quietly cutting a `P × 1` bracket.
        throw new Error(
          'planDraw: an “rr-then-ko” draw has no qualifiers_per_group. The count is ' +
            'required at the write boundary, so a stored event always has one — pass ' +
            'the event’s own value, never a fallback.',
        )
      }
      const dealt = snakedGroups(entryIds, groupIds.length)
      // The snake has already refused a group of fewer than two, so `smallest` is at
      // least 2 and the noun below never needs inflecting.
      const smallest = Math.min(...dealt.map((group) => group.length))
      if (qualifiersPerGroup > smallest) {
        return {
          ok: false,
          detail:
            `Taking ${qualifiersPerGroup} qualifiers from each group is more than the ` +
            `${smallest} entrants in the smallest group — take fewer qualifiers from ` +
            'each group, or add entrants.',
        }
      }
      if (groupIds.length * qualifiersPerGroup < 2) {
        // `K ≥ 1` is a bound at the request boundary and the snake guarantees `P ≥ 1`,
        // so the ONLY way to arrive here is one group taking one qualifier: the sentence
        // is fully determined, and interpolating the counts would add branches no input
        // can reach.
        return {
          ok: false,
          detail:
            'Taking 1 qualifier from a single group leaves one player in the knockout ' +
            'stage, who would have nobody to play — take more qualifiers from each ' +
            'group, or configure more groups.',
        }
      }
      return {
        ok: true,
        fixtures: [
          // The group stage IS round-robin's — the same call, not a second copy of the
          // snake and the circle — so "the groups of an rr-then-ko draw are laid out
          // exactly as a round-robin draw's" is structural rather than two
          // implementations agreeing. Its own stage id, `firstStageId` (`mintStageReads`'s
          // position-0 stage).
          ...planRoundRobinFixtures(entryIds, groupIds, firstStageId),
          // …and the knockout stage is single-elim's bracket, sized `P × K` (derived,
          // never configured, so it cannot contradict the qualifier count) with an EMPTY
          // seed map: nobody has qualified, so every side is TBD. Its own stage id,
          // `knockoutStageId` (`mintStageReads`'s position-1 stage).
          ...planKnockoutFixtures(
            groupIds.length * qualifiersPerGroup,
            new Map(),
            'fx-ko',
            knockoutStageId,
          ),
        ],
      }
    }
    case 'swiss': {
      if (rounds === null) {
        // NOT a refusal, and NOT a default: a `swiss` event without a round count is not a
        // state the server can be in — the write boundary requires one with no default
        // (`SwissDrawSettingsWrite`), so the column is never NULL for this draw type. A
        // stub reaching here has been seeded or patched into a shape the API cannot hold,
        // and says so instead of quietly cutting a one-round event.
        throw new Error(
          'planDraw: a “swiss” draw has no rounds. The count is required at the write ' +
            'boundary, so a stored event always has one — pass the event’s own value, ' +
            'never a fallback.',
        )
      }
      // Round-robin's per-group floor, one level up and group-less, exactly as
      // single-elim's is. The event's GROUPS are not consulted at all: swiss ranks the
      // whole field in one table, so a swiss event with groups cuts perfectly well and
      // one with none is not refused. The two sentences below are the SERVER's, verbatim
      // (`SwissStrategy.plan_initial`), because for a refusal the sentence *is* the answer.
      if (entryIds.length < 2) {
        return {
          ok: false,
          detail:
            'A Swiss draw needs at least 2 entrants — a smaller field has nobody to play.',
        }
      }
      const maximumRounds = maxRematchFreeRounds(entryIds.length)
      if (rounds > maximumRounds) {
        // Past the ceiling a rematch-free swiss cannot exist. Refused at the CUT and not at
        // configure time, because `n` is not known when the setting is written (ADR "swiss
        // pre-cuts every round and pairs each one on advance") — which is exactly why the
        // form's own bound (`swissRoundsSchema`) stops at 32 and says nothing about the
        // field.
        const roundNoun = rounds === 1 ? 'round' : 'rounds'
        const maximumNoun = maximumRounds === 1 ? 'round' : 'rounds'
        return {
          ok: false,
          detail:
            `${rounds} ${roundNoun} is more than the ${maximumRounds} ` +
            `${maximumNoun} a field of ${entryIds.length} entrants can play without a ` +
            'rematch — play fewer rounds, or add entrants.',
        }
      }
      // A swiss event's ONE stage is `firstStageId` — a swiss event has no group stage,
      // and its one stage still mints at `mintStageReads`'s `'s-1'`.
      return { ok: true, fixtures: planSwissFixtures(entryIds, rounds, firstStageId) }
    }
  }
}

/** One wire standings row (`StandingRowRead`, ADR-0788): entry `entry-1`, 1st, a clean
 * 2–0 with a +3 game difference. `game_difference` is the server's own figure
 * (`games_won - games_lost`), carried as-is; the factory keeps it consistent by default. */
export function buildStandingRowRead(
  overrides: Partial<StandingRowRead> = {},
): StandingRowRead {
  return {
    entry_id: 'entry-1',
    rank: 1,
    played: 2,
    wins: 2,
    losses: 0,
    games_won: 4,
    games_lost: 1,
    game_difference: 3,
    ...overrides,
  }
}

/** One wire group's standings (`GroupStandingsRead`): a complete three-player group in
 * the server's finishing order — `entry-1` (2–0) over `entry-4` (1–1) over `entry-5`
 * (0–2). In order, which the client renders untouched (ADR-0788). */
export function buildGroupStandingsRead(
  overrides: Partial<GroupStandingsRead> = {},
): GroupStandingsRead {
  return {
    group_id: 'grp-a',
    complete: true,
    rows: [
      buildStandingRowRead({
        entry_id: 'entry-1',
        rank: 1,
        wins: 2,
        losses: 0,
        games_won: 4,
        games_lost: 1,
        game_difference: 3,
      }),
      buildStandingRowRead({
        entry_id: 'entry-4',
        rank: 2,
        wins: 1,
        losses: 1,
        games_won: 3,
        games_lost: 3,
        game_difference: 0,
      }),
      buildStandingRowRead({
        entry_id: 'entry-5',
        rank: 3,
        wins: 0,
        losses: 2,
        games_won: 1,
        games_lost: 4,
        game_difference: -3,
      }),
    ],
    ...overrides,
  }
}

/** A wire event's `standings` results (`StandingsResultsRead`, ADR-0788): the round-robin arm
 * of the results union, tagged `kind: "standings"` — one complete single group with a champion
 * (`entry-1`, who won it). Single-group so `champion` is meaningful — a multi-group event has no
 * single champion without a knockout stage yet (pass extra `groups` + `champion: null` for
 * that). */
export function buildEventResultsRead(
  overrides: Partial<StandingsResultsRead> = {},
): StandingsResultsRead {
  return {
    kind: 'standings',
    groups: [buildGroupStandingsRead()],
    complete: true,
    champion: 'entry-1',
    ...overrides,
  }
}

/** A wire event's `finishes` results (`FinishesResultsRead`, ADR-0785): the single-elimination
 * arm of the results union, tagged `kind: "finishes"` — a decided four-entrant bracket's
 * placement list, `entry-1` champion (1st), `entry-2` runner-up (2nd), and the two semifinal
 * losers `entry-3`/`entry-4` **tied 3rd**. Pass `finishes` with only the placed entrants +
 * `complete: false` / `champion: null` for a live, partially-played bracket. */
export function buildFinishesResultsRead(
  overrides: Partial<FinishesResultsRead> = {},
): FinishesResultsRead {
  const finish = (o: Partial<FinishRowRead>): FinishRowRead => ({
    entry_id: 'entry-1',
    position: 1,
    eliminated_in_round: null,
    ...o,
  })
  return {
    kind: 'finishes',
    finishes: [
      finish({ entry_id: 'entry-1', position: 1, eliminated_in_round: null }),
      finish({ entry_id: 'entry-2', position: 2, eliminated_in_round: 2 }),
      finish({ entry_id: 'entry-3', position: 3, eliminated_in_round: 1 }),
      finish({ entry_id: 'entry-4', position: 3, eliminated_in_round: 1 }),
    ],
    complete: true,
    champion: 'entry-1',
    ...overrides,
  }
}

/** A wire event's `standings_then_finishes` results (`StandingsThenFinishesResultsRead`,
 * ADR 20260727): the round-robin-then-knockout arm — **both stages at once**, each block the
 * very model its own arm carries.
 *
 * Built for a **six-entrant, two-group** event, and the group memberships are the ones the
 * snake actually deals (`snakedGroups` above: `grp-a` takes entries 1, 4, 5; `grp-b` takes 2,
 * 3, 6) — not a tidier split, because a results fixture that stood over groups its own draw
 * never dealt is a payload the server could not send.
 *
 * The champion is **`entry-4`, who tops neither group.** The group winners are `entry-1` and
 * `entry-2`; `entry-4` qualifies second out of `grp-a` and wins the bracket, beating `entry-1`
 * in the final. That is the format working as designed — the group stage only *seeds* — and
 * it is what lets a test tell a client reading the bracket from one reading the top of a
 * standings table. A fixture whose champion also led a group could not.
 *
 * A **mid-flight** event — groups decided, final unplayed — is
 * `buildStandingsThenFinishesResultsRead({ complete: false, champion: null, finishes: [only
 * the placed entrants] })`. */
export function buildStandingsThenFinishesResultsRead(
  overrides: Partial<StandingsThenFinishesResultsRead> = {},
): StandingsThenFinishesResultsRead {
  const finish = (o: Partial<FinishRowRead>): FinishRowRead => ({
    entry_id: 'entry-1',
    position: 1,
    eliminated_in_round: null,
    ...o,
  })
  return {
    kind: 'standings_then_finishes',
    groups: [
      buildGroupStandingsRead({
        group_id: 'grp-a',
        complete: true,
        rows: [
          buildStandingRowRead({ entry_id: 'entry-1', rank: 1, played: 2, wins: 2, losses: 0, games_won: 4, games_lost: 1, game_difference: 3 }),
          buildStandingRowRead({ entry_id: 'entry-4', rank: 2, played: 2, wins: 1, losses: 1, games_won: 3, games_lost: 3, game_difference: 0 }),
          buildStandingRowRead({ entry_id: 'entry-5', rank: 3, played: 2, wins: 0, losses: 2, games_won: 1, games_lost: 4, game_difference: -3 }),
        ],
      }),
      buildGroupStandingsRead({
        group_id: 'grp-b',
        complete: true,
        rows: [
          buildStandingRowRead({ entry_id: 'entry-2', rank: 1, played: 2, wins: 2, losses: 0, games_won: 4, games_lost: 0, game_difference: 4 }),
          buildStandingRowRead({ entry_id: 'entry-3', rank: 2, played: 2, wins: 1, losses: 1, games_won: 2, games_lost: 3, game_difference: -1 }),
          buildStandingRowRead({ entry_id: 'entry-6', rank: 3, played: 2, wins: 0, losses: 2, games_won: 1, games_lost: 4, game_difference: -3 }),
        ],
      }),
    ],
    finishes: [
      finish({ entry_id: 'entry-4', position: 1, eliminated_in_round: null }),
      finish({ entry_id: 'entry-1', position: 2, eliminated_in_round: 2 }),
      // The two beaten semifinalists — one of them the OTHER group's winner — tied 3rd.
      finish({ entry_id: 'entry-2', position: 3, eliminated_in_round: 1 }),
      finish({ entry_id: 'entry-3', position: 3, eliminated_in_round: 1 }),
    ],
    complete: true,
    champion: 'entry-4',
    ...overrides,
  }
}

/**
 * What the event says about the CALLER entering it (ADR-0783), derived the way the
 * server derives the half of it that is derivable: an event holding `max_players`
 * active entrants is `event_full`, and anything else is `open`.
 *
 * ⚠️ **An UNCAPPED event (`max_players: null`, ADR-0935) is never full** — the API
 * guarantees it, and so does the mock, because a mock that disagrees with the server
 * about a designed state is a mock that will green-light the bug. Written as an
 * explicit null check rather than left to the comparison: `entrants.length >= null`
 * coerces the cap to `0`, so an uncapped event would come back `event_full` the
 * moment anyone entered it — and the card under test would be reading a payload the
 * real API cannot send.
 *
 * `rating_ineligible` is NOT derivable from an event alone — it is a judgement
 * about a player's rating on the tournament's ladder, which no mock payload
 * carries — so a fixture that wants it passes it explicitly. What this function
 * buys is that the *capacity* arm cannot lie: a 64-of-64 event minted by these
 * factories says `event_full`, whatever the caller forgot to pass.
 */
export function entryStateFor(
  event: Pick<TournamentEventRead, 'entrants' | 'max_players'>,
): TournamentEventRead['entry_state'] {
  if (event.max_players === null) return { state: 'open' }
  return event.entrants.length >= event.max_players
    ? { state: 'event_full' }
    : { state: 'open' }
}

/**
 * A rated Bo5 "Open Singles" event with one morning group, as returned by the
 * tournament detail/list endpoints. Defaults are internally consistent so a
 * bare call is a meaningful row.
 *
 * `entered` is NOT an override: like the server (ADR-0016) it is derived from
 * `entrants`, so this factory cannot mint an event whose count disagrees with
 * its list. Want an event with 22 entries? Give it 22 `entrants`.
 *
 * `entry_state` IS an override — the server computes it per caller (ADR-0783), and
 * `rating_ineligible` cannot be derived from an event's own fields — but it
 * **defaults to `entryStateFor`**, so an event filled to `max_players` reports
 * itself full without anybody remembering to say so.
 *
 * `fixtures` defaults to **`[]` — an event with NO DRAW CUT** (ADR-0786), which is the
 * state every event is born in and stays in until a director cuts one. It is an
 * override, not a derivation: a draw is an explicit act against a field, not a function
 * of the entrants (the same 9 players make a different draw across 2 groups than across
 * 3), so a factory that quietly cut one would be inventing a decision nobody made.
 * `planRoundRobinFixtures` above builds a real one for the fixtures that want a *drawn*
 * event.
 */
export function buildTournamentEventRead(
  overrides: Partial<Omit<TournamentEventRead, 'entered'>> = {},
): TournamentEventRead {
  // The one reservation literal for this fixture — written ONCE, and shared by the
  // `reservations` field below and the `groups` fallback further down, so the two can
  // never drift the way two copies of the same literal would.
  const baseReservations: TournamentEventRead['reservations'] = [
    {
      id: 'res-os-1',
      name: 'Reservation A',
      slot: { date: '2026-06-13', start: '09:00', end: '12:30' },
      table_ids: ['t1', 't2', 't3', 't4'],
      // The reservation's place in the event, 0-based — on the READ shape only. The
      // server assigns it from the index of the reservation in the list a write body
      // sent, and `ReservationWrite`/`ReservationUpsert` forbid the key outright, so an
      // override here is describing what came back, never what was asked for.
      position: 0,
    },
  ]
  const event = {
    id: 'ev-open-singles',
    tournament_id: 'bay-area-open-2026',
    name: 'Open Singles',
    format: 'singles',
    // Round-robin, and grouped to match: `DrawType` holds only the two types the server
    // can actually plan (ADR 20260726), and a grouped event is what this fixture's single
    // `Group`/`Reservation` pair describes. A fixture typed as something the API 422s is
    // a fixture that proves nothing.
    draw_type: 'round-robin',
    max_players: 64,
    entry_fee: 45,
    timezone: 'America/Chicago',
    entrants: [],
    entry_state: { state: 'open' },
    fixtures: [],
    slot: { date: '2026-06-13', start: '09:00', end: '18:00' },
    match_settings: { rated: true, length_games: 5 },
    predicates: [],
    // A group maps 1:1 to a reservation (ticket #1369 keeps that lockstep): the server
    // mints exactly one `GroupRead` per `Reservation`, at the same `position`. A fixture
    // with several reservations numbers them 0, 1, 2 … — nothing orders either array by
    // id (see `Reservation.position` / `Group.position`, `data/types`).
    reservations: baseReservations,
    // `groups` is NOT stated here — it is minted 1:1 from `reservations` AFTER the
    // spread below (`groupsFor`), so a fixture overriding `reservations` alone still
    // gets a `groups` array that resolves against them. Server-owned and read-only in
    // either case: the group's own id names the reservation it plays under, and a
    // client never authors one directly (`GroupRead`, ticket #1369).
    // NO RESULTS (ADR-0788) — `null` is the designed state of an event with no draw (and of
    // any non-round-robin event); standings only appear once a draw is cut and matches
    // land. A fixture that wants a table passes a `buildEventResultsRead()` override.
    results: null,
    created_at: '2026-06-01T09:05:00Z',
    updated_at: '2026-06-09T12:00:00Z',
    // The optimistic-concurrency version (#1499) — `1`, what a freshly created event
    // reads. A fixture that wants a version conflict overrides it directly.
    lock_version: 1,
    ...overrides,
    // **No knockout stage to qualify for, so NO qualifier count** (ADR 20260727): `null`
    // is the only value the settings table's `CHECK` admits for a round-robin or
    // single-elim event, and "unset" is not a state that column has. Stated AFTER the
    // spread because the field is required-and-nullable on the read shape (`number |
    // null`, no `?`) while `Partial<…>` admits an explicit `undefined` — so the spread
    // alone would widen it to a type the wire cannot hold.
    qualifiers_per_group: overrides.qualifiers_per_group ?? null,
    // **No chosen round count** (the swiss ADR): a round-robin's rounds come off the circle
    // method, so `null` is the only value its settings arm admits. Stated AFTER the spread
    // for the reason the qualifier count is — the field is required-and-nullable on the read
    // shape while `Partial<…>` admits an explicit `undefined`.
    rounds: overrides.rounds ?? null,
    // **Minted from the event's own (post-override) draw type** (ADR 20260815 decision
    // 3), stated AFTER the spread so it reads the `draw_type` the caller actually asked
    // for. An explicit `stages` override wins outright.
    stages: overrides.stages ?? mintStageReads(overrides.draw_type ?? 'round-robin'),
    // **Minted 1:1 with the event's own (post-override) reservations** (ticket #1369),
    // stated AFTER the spread for the same reason `stages` is: a fixture overriding
    // `reservations` alone gets a `groups` array that actually resolves against them,
    // rather than the base literal's — which is exactly what `groups.ts`'s boundary
    // parser would otherwise refuse as an orphaned group. An explicit `groups` override
    // wins outright, for the one fixture that wants a group naming no reservation.
    groups:
      overrides.groups ?? groupsFor(overrides.reservations ?? baseReservations),
  } satisfies Omit<TournamentEventRead, 'entered'>
  return {
    ...event,
    entry_state: overrides.entry_state ?? entryStateFor(event),
    entered: event.entrants.length,
  }
}

/**
 * The **draw-type catalogue** the tournament-detail payload carries — the rows of the
 * API's `draw_types` table, in `display_order` (ADR "a draw type is a seeded row, and
 * the enum holds only what runs").
 *
 * A row means "this draw type has an implementation", so the set is exactly the members
 * of `DrawType`, and it is **served, never hardcoded client-side**: the picker renders
 * what the server sent, which is what makes "the table gates what a director can pick" a
 * fact about the running system rather than two lists that happen to agree.
 *
 * ⚠️ The `name`/`description` strings are a **verbatim copy of the migration's
 * `DRAW_TYPE_SEED`** (`api/migrations/versions/20260617_0000_0010_create_tournaments_table.py`),
 * not copy invented here. They are the sentences a director actually reads when choosing
 * between the formats, so a mock that paraphrased them would let the picker be built
 * against words the server never sends — and this copy is DB seed data, so a wording
 * change is a migration and has to be re-copied here in the same change.
 *
 * ⚠️ A row here is only half the job: `DRAW_TYPES` (`components/tournaments/data`) is a
 * hardcoded allowlist the catalogue parser filters against **silently**, so a row added
 * here and not there is dropped on the floor with no error and the picker never offers it.
 */
export const DRAW_TYPE_CATALOGUE: DrawTypeRead[] = [
  {
    key: 'round-robin',
    name: 'Round robin',
    description:
      'Everyone in a group plays everyone else in that group. Every entrant is ' +
      'guaranteed the same number of matches and the final standings rank the ' +
      'whole field, so it is the fairest read on form — but the match count ' +
      'climbs quickly with group size, and the event needs at least one group.',
    display_order: 1,
  },
  {
    key: 'single-elim',
    name: 'Single elimination',
    description:
      'A knockout bracket: lose once and you are out. It crowns a champion in ' +
      'the fewest matches and the least table time, which suits a large field ' +
      'or a tight schedule — but half the entrants are finished after one ' +
      'match, and a field that is not a power of two gives the top seeds byes.',
    display_order: 2,
  },
  {
    key: 'rr-then-ko',
    // Pinned by the ADR "rr-then-ko cuts both stages upfront and seeds qualifiers
    // rematch-free" — seed data, so changing either string is a migration there and a
    // re-copy here.
    name: 'Round-robin then knockout',
    description:
      'Groups play all-play-all, then the top finishers from each group meet in a ' +
      'knockout bracket.',
    display_order: 3,
  },
  {
    key: 'swiss',
    // Pinned by the ADR "swiss pre-cuts every round and pairs each one on advance" —
    // seed data (migration `0010`'s `DRAW_TYPE_SEED`), so changing either string is a
    // migration there and a re-copy here.
    name: 'Swiss',
    description:
      'A fixed number of rounds, each pairing entrants who are on similar ' +
      'scores. Nobody is eliminated and everybody plays every round, so a ' +
      'large field is ranked in far fewer matches than a round robin — but a ' +
      "round's pairings are only known once the round before it has finished, " +
      'and a long event may repeat a pairing.',
    display_order: 4,
  },
]

/**
 * A venue name of **680 characters with not one break opportunity in it** — no
 * space, no hyphen, no slash. The pathological row the detail page has to survive
 * (#1199): unwrapped, this single word laid out ~5742px wide and took the
 * document's scroll width to ~3399px inside a 1280px viewport, so the whole page
 * scrolled sideways.
 *
 * It is a **read**-shape fixture, and it is not hypothetical. The server bounds
 * every address component at 255 on the way IN only (`AddressComponent`,
 * `api/app/schemas/tournament.py`) — deliberately, so rows that predate the bound
 * still serialize — and the generated `schema.d.ts` carries no `maxLength` at all.
 * So a client that assumes ≤255 is assuming something neither the wire nor the
 * database promises.
 *
 * Exported from the factory rather than re-typed per suite because BOTH layers
 * need the same string: vitest (which cannot prove the layout claim — jsdom does
 * no layout, `scrollWidth` is always 0 there) and `e2e/`, where a real browser
 * measures it.
 */
export const UNBREAKABLE_VENUE_NAME =
  'BerkeleyTableTennisClubhouseAndCommunityRecreationCentre'
    .repeat(13)
    .slice(0, 680)

/**
 * A tournament name of **255 characters with not one break opportunity in it** —
 * no space, no hyphen, no slash. The hostile title the detail page's header has to
 * survive (#1044).
 *
 * 255, not the venue's 680, and the difference is deliberate: `tournament.name` is
 * a `String(255)` column (`api/app/models/tournament.py`), so this is a row the
 * server can hold **today**. The venue fixture's 680 rests on a story this string
 * has no claim to — address components are bounded on the way IN only, so longer
 * legacy rows still come back over the wire. A fixture is worth more when it is a
 * state the product can actually produce.
 *
 * It is one unbroken word, so its min-content width is its whole rendered width.
 * That is the point: the `h1` carries `break-words`, and only a name with no break
 * opportunity of its own puts that class under any load at all. A name with spaces
 * in it wraps whether the class is there or not, so a test built on one would pass
 * against a header that had lost the class entirely.
 *
 * Exported from the factory rather than re-typed per suite, for the same reason
 * `UNBREAKABLE_VENUE_NAME` is: both layers need the same string, and only one of
 * them (`e2e/`, a real browser) can measure what it does.
 */
export const UNBREAKABLE_TOURNAMENT_NAME =
  'QuinnOpenInternationalTableTennisChampionshipInvitational'
    .repeat(5)
    .slice(0, 255)

/**
 * The published "Bay Area Open 2026" with a four-table catalogue and a single
 * Open Singles event, owned (editable) by the current user. The list and detail
 * endpoints both return this `TournamentDetailRead` shape.
 *
 * `draw_type_catalogue` defaults to the served catalogue, because this builds the
 * **detail** payload — the LIST route sends `null` there (the catalogue is page data for
 * the one page that picks a draw type), so a list fixture passes that explicitly.
 *
 * `league_id` is the ladder its eligibility rules are judged against (ADR-0783)
 * — the **default** league here, as an omitted one resolves to on the server.
 * Nothing renders it yet; it is carried so the fixture is the shape the wire
 * actually sends.
 */
export function buildTournamentDetailRead(
  overrides: Partial<TournamentDetailRead> = {},
): TournamentDetailRead {
  return {
    id: 'bay-area-open-2026',
    name: 'Bay Area Open 2026',
    description: 'Two-day open. USATT-sanctioned, ratings-eligible.',
    status: 'published',
    start_date: '2026-06-13',
    end_date: '2026-06-14',
    league_id: FORTYMM_LEAGUE_ID,
    address: {
      venue: 'Berkeley TT Club',
      street: '2727 Milvia St',
      city: 'Berkeley',
      region: 'CA',
      postal: '94703',
      country: 'USA',
      latitude: 37.8715,
      longitude: -122.273,
    },
    table_catalogue: [
      buildTournamentTable({ id: 't1', label: 'T1', court: '1' }),
      buildTournamentTable({ id: 't2', label: 'T2', court: '2' }),
      buildTournamentTable({ id: 't3', label: 'T3', court: '3' }),
      buildTournamentTable({ id: 't4', label: 'T4', court: '4' }),
    ],
    created_by_user_id: 'u-me',
    created_by_username: 'rita.kovac',
    can_edit: true,
    created_at: '2026-06-01T09:00:00Z',
    updated_at: '2026-06-10T12:00:00Z',
    events: [buildTournamentEventRead()],
    // NO SOLVE YET — `null` is the state every tournament is born in, and the state
    // it stays in until something (go-live, the Run-scheduler button, a completed
    // match) puts a run on the queue. A fixture that wants a solve on the strip
    // passes a `buildScheduleSolveRead()` override.
    latest_schedule_solve: null,
    draw_type_catalogue: DRAW_TYPE_CATALOGUE,
    ...overrides,
  }
}
