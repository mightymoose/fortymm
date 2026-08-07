// The **schedule solve** boundary (ADR "the schedule is solved; the call is pinned"):
// where the tournament detail's `latest_schedule_solve` stops being bytes off the wire
// and becomes a typed domain value — and where every word the solve strip says about
// it is decided.
//
// Why a Zod parse and not just the generated types: same answer as `./fixtures.ts`.
// `schema.d.ts` is a compile-time claim, the network is untrusted
// (`.claude/rules/parse-at-boundaries.md`), and the strip switches on `status` /
// `trigger` / `verdict` by value — so an enum member this client does not know must
// fail HERE, inside the queryFn, rather than fall out of a `switch` three components
// later as an unrenderable strip.
//
// **Raw API strings never reach the UI** (`DEFINITION_OF_COMPLETE.md`): the three
// enums are mapped to the client's own copy below (`TRIGGER_LABEL`, `VERDICT_LABEL`,
// the strip's per-state sentences), and the run-refusal 422/403/503 each get a
// designed notice (`runSchedulerNotice`). The one server sentence that survives is a
// `failed` run's `error` — like the draw panel's 409/422 sentences, it is the
// actionable content, shown as detail under the client's own headline.

import { z } from 'zod'

import { ApiError } from '@/api/client'
import type { components } from '@/api/schema'

import { conjoinWithAnd, fmtDate } from './helpers'
import type { TournamentStatus } from './types'

type ScheduleSolveWire = components['schemas']['ScheduleSolveRead']

/** The six triggers, as the wire's `ScheduleSolveTrigger` enum spells them.
 * `satisfies` pins this closed set to the generated schema, so the runtime parser
 * and the OpenAPI contract cannot drift: a trigger added to the API is a compile
 * error here until it is given copy in `TRIGGER_LABEL` below. */
const SCHEDULE_SOLVE_TRIGGERS = [
  'go_live',
  'match_completed',
  'settings_changed',
  'manual',
  'pin_tick',
  'rerun',
] as const satisfies readonly ScheduleSolveWire['trigger'][]

/** The five run statuses (`ScheduleSolveStatus`). `infeasible` is a terminal
 * *outcome*, not a failure — the solver proved the day does not fit, which is the
 * whole point of a pre-live solve; `failed` means the job itself broke. */
const SCHEDULE_SOLVE_STATUSES = [
  'queued',
  'running',
  'succeeded',
  'infeasible',
  'failed',
] as const satisfies readonly ScheduleSolveWire['status'][]

/** CP-SAT's own answer (`SolverVerdict`), separate from the run's status on
 * purpose: a run can end `succeeded` on a merely `feasible` verdict — FEASIBLE is
 * accepted under the time cap, because mid-tournament we want a good answer now,
 * not a proof. */
const SOLVER_VERDICTS = [
  'optimal',
  'feasible',
  'infeasible',
] as const satisfies readonly NonNullable<ScheduleSolveWire['verdict']>[]

export const scheduleSolveTriggerSchema = z.enum(SCHEDULE_SOLVE_TRIGGERS)
export const scheduleSolveStatusSchema = z.enum(SCHEDULE_SOLVE_STATUSES)
export const solverVerdictSchema = z.enum(SOLVER_VERDICTS)

export type ScheduleSolveTrigger = z.infer<typeof scheduleSolveTriggerSchema>
export type ScheduleSolveStatus = z.infer<typeof scheduleSolveStatusSchema>
export type SolverVerdict = z.infer<typeof solverVerdictSchema>

// ----- a named fixture: the one shape BOTH unions carry -----------------------
//
// `ConflictFixtureRead` is deliberately shared on the wire (see its docstring in
// `schema.d.ts`): a placement conflict names the fixtures it caught, and the
// conflict core names the fixtures it could not place, with the *same* shape — so
// the client renders a named fixture identically wherever it appears. It lives
// above both unions because both parse through it at module-init time; hoisting a
// `const` schema is not a thing, so ordering here is load-bearing.

type ConflictFixtureWire = components['schemas']['ConflictFixtureRead']

/** One fixture named the way the director reads a match — by its **matchup**, the
 * two players facing off. The raw `fixtureId` rides along so a surface can
 * key/deep-link without re-deriving it. Carried by the placement-conflict arms
 * *and* by the infeasibility union's `unplaceable_fixtures` (the conflict core). */
export interface ConflictFixture {
  fixtureId: string
  playerA: string
  playerB: string
}

/** The wire fixture, as it really arrives: snake_case. `satisfies` it against the
 * generated schema so a field renamed in the API is a compile error here. */
const conflictFixtureWireSchema = z.object({
  fixture_id: z.string(),
  player_a: z.string(),
  player_b: z.string(),
}) satisfies z.ZodType<ConflictFixtureWire>

function conflictFixtureFromWire(f: ConflictFixtureWire): ConflictFixture {
  return { fixtureId: f.fixture_id, playerA: f.player_a, playerB: f.player_b }
}

/** A fixture's matchup label — the two players facing off, `crafty-vs-spiked`.
 * How the director already reads a match, so every sentence built out of these
 * names matches rather than ids. Shared by the placement-conflict caution and by
 * the conflict core's sentence, so the two cannot drift on how a match reads. */
export function conflictFixtureLabel(fixture: ConflictFixture): string {
  return `${fixture.playerA}-vs-${fixture.playerB}`
}

// ----- why the day doesn't fit: the resolved infeasibility reasons ------------
//
// An `infeasible` solve no longer speaks in one opaque "Doesn't fit" — the API
// resolves the causes to names/numbers at apply time (the ADR
// "an-infeasible-solve-explains-itself-with-a-resolved-reason") and ships them
// as a closed sum type on `ScheduleSolveRead.infeasibility_reasons`: always a
// list, `[]` off the infeasible path. The `kind` discriminant is *data* the
// client switches on, so — like `status`/`trigger`/`verdict` — an arm this
// client has no words for must FAIL the parse here, in the queryFn, not fall
// out of a `switch` two components later as a blank row (`z.discriminatedUnion`
// rejects an unknown discriminator). Names + numbers are data (a `pool_name` is
// like a username); the *sentence* is still the client's, minted in
// `infeasibilityReasonCopy` below, so "raw API strings never reach the UI" holds.

type PoolHasNoTablesWire =
  components['schemas']['PoolHasNoTablesRead']
type WindowTooShortForMatchWire =
  components['schemas']['WindowTooShortForMatchRead']
type PoolOverCapacityWire =
  components['schemas']['PoolOverCapacityRead']
type PlayerOverSubscribedWire =
  components['schemas']['PlayerOverSubscribedRead']
type UnplaceableFixturesWire =
  components['schemas']['UnplaceableFixturesRead']
type NoSingleCauseWire =
  components['schemas']['NoSingleCauseRead']
type PastWindowReasonWire =
  components['schemas']['PastWindowReasonRead']

/**
 * One resolved reason an `infeasible` solve carries, in the domain's camelCase
 * spelling — a discriminated union over `kind`, one arm per structural cause the
 * solver can name, plus the honestly-labelled residual (`no_single_cause`). The
 * `kind` string stays snake_case (it is the wire's discriminant, and the copy
 * module + admin ledger switch on it); every other field is mapped snake→camel
 * like the rest of this module.
 *
 * - **`pool_has_no_tables`** — a pool with fixtures but nowhere to place them.
 * - **`window_too_short_for_match`** — a single match cannot fit its pool window
 *   contiguously, whatever the table count.
 * - **`pool_over_capacity`** — a pool's aggregate match-time exceeds what its
 *   window × tables can hold (a *certain* pre-check, not a CP-SAT guess).
 * - **`player_over_subscribed`** — ONE human is in more matches inside a pool's
 *   window than that window can hold, counting the rest owed between them: a
 *   pigeonhole over a single person (CONTEXT.md, "Over-subscribed"), so it is the
 *   one structural cause that names a *person* rather than a pool or fixture —
 *   and the one where adding tables is provably useless (extra tables let *other*
 *   people play in parallel, never this one).
 * - **`unplaceable_fixtures`** — the **conflict core** (CONTEXT.md): the matches a
 *   proven-infeasible day could not place, each named by its matchup. It is the
 *   *which* behind a timing conflict, and the one arm that is explicitly **not** a
 *   proof of anything minimal: the API extracts it from a capped optimization, so
 *   it is a set whose removal lets the day fit (an upper bound), never "the
 *   smallest set" (ADR "the conflict core is a second, max-placed solve",
 *   decision 4). Nothing in this client may word it as a minimum.
 * - **`no_single_cause`** — CP-SAT proved infeasible but arms 1–4 all passed and
 *   no core could be extracted either: a *timing* conflict, never a raw-capacity
 *   shortfall (so: don't add tables). The floor, not the residual.
 * - **`past_window`** — a pool's ENTIRE planned window is already a day behind
 *   now (ADR "a past day is named, not disguised"), fixed by moving the date, not
 *   by adding tables/time. Carries the offending venue-local `date` (`YYYY-MM-DD`,
 *   resolved server-side in the event's own timezone frame, so the client does no
 *   tz math of its own).
 */
export type InfeasibilityReason =
  | { kind: 'pool_has_no_tables'; poolName: string }
  | {
      kind: 'window_too_short_for_match'
      poolName: string
      windowStart: string
      windowEnd: string
      bestOf: 1 | 3 | 5 | 7
      neededMin: number
      windowSpanMin: number
    }
  | {
      kind: 'pool_over_capacity'
      poolName: string
      windowStart: string
      windowEnd: string
      requiredMin: number
      capacityMin: number
      tableCount: number
    }
  | {
      kind: 'player_over_subscribed'
      playerName: string
      poolName: string
      windowStart: string
      windowEnd: string
      matchCount: number
      requiredMin: number
      windowSpanMin: number
    }
  | { kind: 'unplaceable_fixtures'; fixtures: ConflictFixture[] }
  | { kind: 'no_single_cause'; requiredMin: number; availableMin: number }
  | { kind: 'past_window'; date: string }

/** The wire arms, as they really arrive: snake_case, `kind` a literal so the
 * union below can discriminate on it. `satisfies` each against the generated
 * schema so a field renamed in the API is a compile error here, not a silent
 * `undefined` at render. */
const poolHasNoTablesWireSchema = z.object({
  kind: z.literal('pool_has_no_tables'),
  pool_name: z.string(),
}) satisfies z.ZodType<PoolHasNoTablesWire>

const windowTooShortForMatchWireSchema = z.object({
  kind: z.literal('window_too_short_for_match'),
  pool_name: z.string(),
  window_start: z.string(),
  window_end: z.string(),
  best_of: z.union([z.literal(1), z.literal(3), z.literal(5), z.literal(7)]),
  needed_min: z.number().int(),
  window_span_min: z.number().int(),
}) satisfies z.ZodType<WindowTooShortForMatchWire>

const poolOverCapacityWireSchema = z.object({
  kind: z.literal('pool_over_capacity'),
  pool_name: z.string(),
  window_start: z.string(),
  window_end: z.string(),
  required_min: z.number().int(),
  capacity_min: z.number().int(),
  table_count: z.number().int(),
}) satisfies z.ZodType<PoolOverCapacityWire>

const playerOverSubscribedWireSchema = z.object({
  kind: z.literal('player_over_subscribed'),
  player_name: z.string(),
  pool_name: z.string(),
  window_start: z.string(),
  window_end: z.string(),
  match_count: z.number().int(),
  required_min: z.number().int(),
  window_span_min: z.number().int(),
}) satisfies z.ZodType<PlayerOverSubscribedWire>

/** The conflict core. `fixtures` reuses the shared `conflictFixtureWireSchema`
 * above — one shape on the wire, one parser here, so a fixture named by a
 * placement conflict and a fixture named by the core can never drift apart. */
const unplaceableFixturesWireSchema = z.object({
  kind: z.literal('unplaceable_fixtures'),
  fixtures: z.array(conflictFixtureWireSchema),
}) satisfies z.ZodType<UnplaceableFixturesWire>

const noSingleCauseWireSchema = z.object({
  kind: z.literal('no_single_cause'),
  required_min: z.number().int(),
  available_min: z.number().int(),
}) satisfies z.ZodType<NoSingleCauseWire>

const pastWindowReasonWireSchema = z.object({
  kind: z.literal('past_window'),
  date: z.string(),
}) satisfies z.ZodType<PastWindowReasonWire>

/** The seven arms as one `z.discriminatedUnion('kind', …)` — an unknown `kind`
 * has no arm and throws, which is exactly the boundary rule: a reason this
 * client cannot render must fail the parse, not blank the row. */
export const infeasibilityReasonWireSchema = z.discriminatedUnion('kind', [
  poolHasNoTablesWireSchema,
  windowTooShortForMatchWireSchema,
  poolOverCapacityWireSchema,
  playerOverSubscribedWireSchema,
  unplaceableFixturesWireSchema,
  noSingleCauseWireSchema,
  pastWindowReasonWireSchema,
])

/** One wire arm → one domain `InfeasibilityReason`. Annotated `: InfeasibilityReason`
 * so the union above and the wire arms are one thing — drop or rename a field on
 * either and this is a compile error. Exhaustive over `kind` (a `never` default),
 * so a further arm added to the API cannot slip through unmapped. */
export function infeasibilityReasonFromWire(
  r: z.infer<typeof infeasibilityReasonWireSchema>,
): InfeasibilityReason {
  switch (r.kind) {
    case 'pool_has_no_tables':
      return { kind: r.kind, poolName: r.pool_name }
    case 'window_too_short_for_match':
      return {
        kind: r.kind,
        poolName: r.pool_name,
        windowStart: r.window_start,
        windowEnd: r.window_end,
        bestOf: r.best_of,
        neededMin: r.needed_min,
        windowSpanMin: r.window_span_min,
      }
    case 'pool_over_capacity':
      return {
        kind: r.kind,
        poolName: r.pool_name,
        windowStart: r.window_start,
        windowEnd: r.window_end,
        requiredMin: r.required_min,
        capacityMin: r.capacity_min,
        tableCount: r.table_count,
      }
    case 'player_over_subscribed':
      return {
        kind: r.kind,
        playerName: r.player_name,
        poolName: r.pool_name,
        windowStart: r.window_start,
        windowEnd: r.window_end,
        matchCount: r.match_count,
        requiredMin: r.required_min,
        windowSpanMin: r.window_span_min,
      }
    case 'unplaceable_fixtures':
      return {
        kind: r.kind,
        // The same `conflictFixtureFromWire` the placement conflicts use — one
        // mapping for one wire shape.
        fixtures: r.fixtures.map(conflictFixtureFromWire),
      }
    case 'no_single_cause':
      return {
        kind: r.kind,
        requiredMin: r.required_min,
        availableMin: r.available_min,
      }
    case 'past_window':
      // Domain shape equals the wire shape (single-word `date`), carries straight
      // through — no snake→camel mapping needed.
      return { kind: r.kind, date: r.date }
    default: {
      const exhaustive: never = r
      return exhaustive
    }
  }
}

/** The per-reason parser: the wire arm plus the snake→camel mapping, one Zod
 * pipeline. Embedded in `scheduleSolveWireSchema` below, which the admin ledger's
 * wire schema `.extend()`s — so both surfaces parse reasons through this one arm. */
export const infeasibilityReasonSchema =
  infeasibilityReasonWireSchema.transform(infeasibilityReasonFromWire)

// ----- overlapping in-progress matches: the resolved placement conflicts ------
//
// A solve tolerates two *in-progress* matches that a soft manual PATCH parked on
// the same table or the same human (the ADR "overlapping-in-progress-matches-
// are-tolerated-and-reported") — it never blanks the board over contradictory
// data, it keeps the fixed blocks binding and *reports* the overlap. The report
// is DB-resolved at apply (ids → a table label / a human's name, each fixture
// named by its matchup) and shipped on `ScheduleSolveRead.placement_conflicts`:
// ALWAYS a list, `[]` on a clean board — and, unlike the infeasibility reasons,
// present on ANY verdict (a *placed* board can still carry a caution; the two
// are orthogonal). The `kind` discriminant is data the surfaces switch on, so —
// like the infeasibility arms — a conflict kind this client has no words for
// must FAIL the parse here, not blank a warning row two components later. Names
// are data (a `player_name` is like a username); the *sentence* is the client's,
// minted in `placementConflictSentence` below.

type TableConflictWire = components['schemas']['TableConflictRead']
type PlayerConflictWire = components['schemas']['PlayerConflictRead']

/**
 * One resolved placement conflict a solve carries, in the domain's camelCase — a
 * discriminated union over `kind`, one arm per shared resource two overlapping
 * in-progress matches can contradict. The `kind` string stays snake_case (it is
 * the wire's discriminant); every other field is mapped snake→camel.
 *
 * - **`table_conflict`** — two in-progress matches recorded on the same table at
 *   overlapping times (a table holds one match).
 * - **`player_conflict`** — two in-progress matches sharing a human whose
 *   occupancy overlaps (a human plays one match at a time).
 */
export type PlacementConflict =
  | { kind: 'table_conflict'; tableLabel: string; fixtures: ConflictFixture[] }
  | { kind: 'player_conflict'; playerName: string; fixtures: ConflictFixture[] }

const tableConflictWireSchema = z.object({
  kind: z.literal('table_conflict'),
  table_label: z.string(),
  fixtures: z.array(conflictFixtureWireSchema),
}) satisfies z.ZodType<TableConflictWire>

const playerConflictWireSchema = z.object({
  kind: z.literal('player_conflict'),
  player_name: z.string(),
  fixtures: z.array(conflictFixtureWireSchema),
}) satisfies z.ZodType<PlayerConflictWire>

/** The two arms as one `z.discriminatedUnion('kind', …)` — an unknown `kind` has
 * no arm and throws, which is exactly the boundary rule: a conflict this client
 * cannot render must fail the parse, not blank the warning. */
export const placementConflictWireSchema = z.discriminatedUnion('kind', [
  tableConflictWireSchema,
  playerConflictWireSchema,
])

/** One wire arm → one domain `PlacementConflict`. Annotated so the union above
 * and the wire arms are one thing. Exhaustive over `kind` (a `never` default), so
 * a third arm added to the API cannot slip through unmapped. */
export function placementConflictFromWire(
  c: z.infer<typeof placementConflictWireSchema>,
): PlacementConflict {
  switch (c.kind) {
    case 'table_conflict':
      return {
        kind: c.kind,
        tableLabel: c.table_label,
        fixtures: c.fixtures.map(conflictFixtureFromWire),
      }
    case 'player_conflict':
      return {
        kind: c.kind,
        playerName: c.player_name,
        fixtures: c.fixtures.map(conflictFixtureFromWire),
      }
    default: {
      const exhaustive: never = c
      return exhaustive
    }
  }
}

/** The per-conflict parser: the wire arm plus the snake→camel mapping, one Zod
 * pipeline. Embedded in `scheduleSolveWireSchema` below, which the admin ledger's
 * wire schema `.extend()`s — so both surfaces parse conflicts through this arm. */
export const placementConflictSchema =
  placementConflictWireSchema.transform(placementConflictFromWire)

/**
 * One row of the tournament's **solve ledger**, in the domain's spelling — the
 * latest run of the placement solver, as the detail payload carries it.
 *
 * **Every `null` marks a stage not (or never) reached**, not a missing field:
 * `verdict` is null until the solver has actually run (and forever, for a run that
 * failed before reaching it); `startedAt`/`finishedAt` are null while the run is
 * still queued/running; `wallTimeMs` and the two apply counts are null until it
 * finishes; `error` is set only on a `failed` run.
 *
 * `overrunning` is a *success qualifier*, not a stage: `true` only on a
 * `succeeded` run whose plan ran a fixture past its pool's **planned** window
 * end while the tournament is **live** (the window went soft so the day keeps
 * being scheduled into the overrun instead of wedging "doesn't fit", ADR
 * "the solver stops wedging"). Always `false` pre-live and on any run that
 * placed nothing (`infeasible` / `failed`) — never `null`.
 */
export interface ScheduleSolve {
  id: string
  trigger: ScheduleSolveTrigger
  status: ScheduleSolveStatus
  verdict: SolverVerdict | null
  requestedAt: string
  startedAt: string | null
  finishedAt: string | null
  wallTimeMs: number | null
  fixturesPlaced: number | null
  fixturesPinned: number | null
  overrunning: boolean
  error: string | null
  /** Why the day doesn't fit — **always a list**, never null (`[]` off the
   * infeasible path; one or more resolved causes on an `infeasible` row). Not a
   * nullable stage marker like the fields above: the API guarantees the array is
   * present, and an absent key is a payload we reject rather than read as `[]`. */
  infeasibilityReasons: InfeasibilityReason[]
  /** Overlapping in-progress matches the solve *tolerated and reported* — **always
   * a list**, never null (`[]` on a clean board). Orthogonal to the verdict: a
   * placed/succeeded board can still carry a caution here. Like the reasons, an
   * absent key is a payload we reject rather than read as `[]`. */
  placementConflicts: PlacementConflict[]
}

/** The wire shape (`ScheduleSolveRead`), as it really arrives: snake_case, every
 * nullable present (`.nullable()`, never `.optional()` — an absent key is a payload
 * we cannot tell apart from a stage not reached). Exported so the admin ledger's
 * wire schema (`components/scheduling/queries.ts`) can `.extend()` it with the
 * operator-only fields rather than re-spelling these. */
export const scheduleSolveWireSchema = z.object({
  id: z.string(),
  trigger: scheduleSolveTriggerSchema,
  status: scheduleSolveStatusSchema,
  verdict: solverVerdictSchema.nullable(),
  requested_at: z.string(),
  started_at: z.string().nullable(),
  finished_at: z.string().nullable(),
  wall_time_ms: z.number().nullable(),
  fixtures_placed: z.number().int().nullable(),
  fixtures_pinned: z.number().int().nullable(),
  overrunning: z.boolean(),
  error: z.string().nullable(),
  // Always present (a non-nullable list); each element is parsed through the
  // discriminated union, so an unknown arm `kind` fails the whole row.
  infeasibility_reasons: z.array(infeasibilityReasonSchema),
  // Always present too, and on ANY verdict (a placed board can still carry a
  // caution); each element parsed through the conflict union, so an unknown arm
  // `kind` fails the whole row.
  placement_conflicts: z.array(placementConflictSchema),
})

/** The snake→camel mapping, one wire row → one domain `ScheduleSolve`. Annotated
 * `: ScheduleSolve` so the interface above and the wire schema are one thing — drop
 * a field from either and this is a compile error (the `./fixtures.ts` pattern).
 * Exported so the admin ledger's transform spreads this base mapping rather than
 * re-spelling it. */
export function scheduleSolveFromWire(
  s: z.infer<typeof scheduleSolveWireSchema>,
): ScheduleSolve {
  return {
    id: s.id,
    trigger: s.trigger,
    status: s.status,
    verdict: s.verdict,
    requestedAt: s.requested_at,
    startedAt: s.started_at,
    finishedAt: s.finished_at,
    wallTimeMs: s.wall_time_ms,
    fixturesPlaced: s.fixtures_placed,
    fixturesPinned: s.fixtures_pinned,
    overrunning: s.overrunning,
    error: s.error,
    // Already snake→camel-mapped by `infeasibilityReasonSchema`'s transform.
    infeasibilityReasons: s.infeasibility_reasons,
    // Already snake→camel-mapped by `placementConflictSchema`'s transform.
    placementConflicts: s.placement_conflicts,
  }
}

/** The parser: the wire schema plus the mapping above, as one Zod pipeline. */
export const scheduleSolveSchema = scheduleSolveWireSchema.transform(scheduleSolveFromWire)

/** Parse a 202's ledger row (the Run-scheduler response), or throw. `unknown` on
 * purpose — the generated type is exactly the claim this checks. */
export function parseScheduleSolve(input: unknown): ScheduleSolve {
  return scheduleSolveSchema.parse(input)
}

/** Parse the detail payload's `latest_schedule_solve`, or throw. **`null` is the
 * designed "no solve yet" state** — the state every tournament is born in — and
 * parses straight through; what is not tolerated is an *absent* field or a
 * malformed row, both of which must fail the query rather than render as a blank
 * strip. */
export function parseLatestScheduleSolve(input: unknown): ScheduleSolve | null {
  return scheduleSolveSchema.nullable().parse(input)
}

// ----- the strip's designed states ------------------------------------------

/**
 * What the solve strip renders — a sum type over the ledger row, so the strip's
 * `switch` is total and a new status cannot fall through to a blank
 * (`DEFINITION_OF_COMPLETE.md`: sum types, no tri-state booleans).
 *
 * `infeasible` is deliberately its own arm and NOT folded into `failed`: it is a
 * *designed outcome* — the solver proved the day does not fit, which is the whole
 * point of pre-live solves — not an error banner.
 */
export type SolveStripState =
  | { kind: 'none' }
  | { kind: 'solving'; trigger: ScheduleSolveTrigger }
  | {
      kind: 'succeeded'
      /** Narrowed to the two verdicts a succeeded run can honestly carry. A
       * `succeeded` row whose verdict is missing degrades to `feasible` — the
       * modest claim — rather than inventing optimality or refusing to render. */
      verdict: 'optimal' | 'feasible'
      /** The plan ran a fixture past its pool's planned window while the
       * tournament is live — the soft-window overrun (ADR "the solver stops
       * wedging"). The strip surfaces this as a calm "overrunning" badge, NOT a
       * "doesn't fit" error: the day is still being scheduled, just past plan.
       * Only ever `true` on this `succeeded` arm. */
      overrunning: boolean
      wallTimeMs: number | null
      finishedAt: string | null
      trigger: ScheduleSolveTrigger
    }
  | {
      kind: 'infeasible'
      finishedAt: string | null
      trigger: ScheduleSolveTrigger
      /** The resolved causes the day doesn't fit — the same list the ledger row
       * carries (`≥1` on an infeasible row; the strip renders each via
       * `infeasibilityReasonCopy`, falling back to its generic sentence if empty).
       * Includes the `past_window` arm — a day dated in the past. */
      reasons: InfeasibilityReason[]
    }
  | {
      kind: 'failed'
      /** The server's own account of why the job broke, or `null`. Shown as
       * detail under the client's headline — the one wire sentence the strip
       * carries, because it is the actionable content (the draw-panel precedent). */
      error: string | null
      trigger: ScheduleSolveTrigger
    }

/** The verdict a `succeeded` run can honestly claim: a succeeded row whose verdict
 * is missing degrades to `feasible` — the modest claim — rather than inventing
 * optimality or refusing to render. ONE rule, consumed by the strip below and the
 * admin ledger's chip (`components/scheduling/ledger.ts`), so the two surfaces
 * cannot drift on what a verdict-less success reads as. */
export function succeededVerdict(
  verdict: SolverVerdict | null,
): 'optimal' | 'feasible' {
  return verdict === 'optimal' ? 'optimal' : 'feasible'
}

/** Reduce the latest ledger row to the strip's state. Pure, so it is unit-tested
 * rather than asserted through a DOM (the `./schedule.ts` shape). */
export function solveStripState(solve: ScheduleSolve | null): SolveStripState {
  if (solve === null) return { kind: 'none' }
  switch (solve.status) {
    case 'queued':
    case 'running':
      return { kind: 'solving', trigger: solve.trigger }
    case 'succeeded':
      return {
        kind: 'succeeded',
        verdict: succeededVerdict(solve.verdict),
        overrunning: solve.overrunning,
        wallTimeMs: solve.wallTimeMs,
        finishedAt: solve.finishedAt,
        trigger: solve.trigger,
      }
    case 'infeasible':
      return {
        kind: 'infeasible',
        finishedAt: solve.finishedAt,
        trigger: solve.trigger,
        reasons: solve.infeasibilityReasons,
      }
    case 'failed':
      return { kind: 'failed', error: solve.error, trigger: solve.trigger }
    default: {
      // A status added to the API and not yet here is a COMPILE error (the parse
      // above already refused it at runtime).
      const exhaustive: never = solve.status
      return exhaustive
    }
  }
}

/** True while a run is on the queue or on the solver — the state in which the
 * Run-scheduler button is withheld (one solve in flight per tournament: another
 * click would be absorbed anyway) and the client polls fast. */
export function solveInFlight(solve: ScheduleSolve | null): boolean {
  return solve !== null && (solve.status === 'queued' || solve.status === 'running')
}

// ----- copy: enums → the director's words ------------------------------------

/** What put the run on the queue, as the strip's sub-clause. Keyed over the enum
 * so a new trigger is a compile error until it has words, never a raw `pin_tick`
 * on screen. */
export const TRIGGER_LABEL: Record<ScheduleSolveTrigger, string> = {
  manual: 'Run by hand',
  go_live: 'Run when the tournament went live',
  match_completed: 'Run after a match finished',
  settings_changed: 'Run after a scheduling change',
  pin_tick: 'Run by the routine live check',
  rerun: 'Re-run after a change arrived mid-solve',
}

/** The verdict, in the director's terms: what kind of plan they are looking at.
 * `feasible` is honest about the time cap without apologising for it. */
export const VERDICT_LABEL: Record<'optimal' | 'feasible', string> = {
  optimal: 'Best possible plan',
  feasible: 'Good plan, found under the time cap',
}

/** The solver's wall time, human-sized: `850 ms`, `2.4s`. `null` (a stage not
 * reached) renders as nothing — the caller drops the clause. */
export function fmtWallTime(ms: number | null): string | null {
  if (ms === null) return null
  if (ms < 1000) return `${Math.round(ms)} ms`
  return `${(ms / 1000).toFixed(1)}s`
}

// ----- copy: the infeasibility reasons → the director's words -----------------
//
// ONE shared module, in the spirit of `VERDICT_LABEL`: both the Schedule-tab
// solve strip (chore 4b) and the admin solve ledger (chore 4c) import
// `infeasibilityReasonCopy` and render the SAME `sentence` + `remedy`, so the two
// surfaces cannot drift on how a reason reads. Pure functions, unit-tested here.

/** A pool's table-time, human-sized in the *prose*' spirit of `fmtWallTime`:
 * a bare `8h` / `1.3h` / `45 min`, WITHOUT a leading "about" — the sentences
 * below own that word ("… need about {…}"), so the formatter must not double it.
 * Hours to one decimal when not whole (`75 min → 1.3h`), a whole number when it
 * is (`480 min → 8h`), and plain minutes under the hour (`45 min`). */
export function fmtTableTime(min: number): string {
  if (min < 60) return `${Math.round(min)} min`
  const hours = Math.round((min / 60) * 10) / 10
  return Number.isInteger(hours) ? `${hours}h` : `${hours.toFixed(1)}h`
}

/** `1 table` / `5 tables` — sane pluralisation for the reason sentences. */
export function fmtTables(count: number): string {
  return `${count} ${count === 1 ? 'table' : 'tables'}`
}

/** What a caller renders for one reason: the client's own sentence naming the
 * cause, and a user-facing remedy. Both interpolate the resolved names/numbers;
 * neither carries a GitHub issue number (the ADR's rule). */
export interface InfeasibilityReasonCopy {
  sentence: string
  remedy: string
}

/**
 * Map one resolved reason to its designed copy. Exhaustive over `kind` — a `never`
 * default makes a further arm added to the API a compile error here until it is
 * given words, so a reason can never reach the UI as a blank line.
 *
 * Three arms are deliberately worded to steer the director *away* from adding
 * tables, for three different reasons:
 *
 * - the floor (`no_single_cause`), because by construction there is a
 *   table-time surplus — the problem is timing, not capacity;
 * - `player_over_subscribed`, because a table is parallelism and this is a
 *   pigeonhole over ONE human — a second table lets somebody *else* play, never
 *   this person twice at once. Its remedies are fewer matches for them in that
 *   pool, or a longer window (ADR "the conflict core is a second, max-placed
 *   solve", decision 1);
 * - `unplaceable_fixtures`, which is that same timing conflict *named* — it is
 *   reached only once every capacity pre-check has passed, so there is table-time
 *   to spare here too.
 *
 * And `unplaceable_fixtures` carries a second, harder rule: **it must never claim
 * minimality.** The API extracts that set from an optimization under a time cap,
 * so it may be a good-enough answer rather than a proven-smallest one, and it
 * carries no proven/partial flag to tell the two apart — deliberately (ADR
 * decision 4). The sentence therefore has to be true under *both* outcomes: "these
 * couldn't all be placed" and "not necessarily the smallest set", never "you must
 * remove exactly these" or "the minimum set is". A test pins that.
 */
export function infeasibilityReasonCopy(
  reason: InfeasibilityReason,
): InfeasibilityReasonCopy {
  switch (reason.kind) {
    case 'pool_has_no_tables':
      return {
        sentence: `${reason.poolName} has no tables assigned.`,
        remedy: `Assign at least one table to ${reason.poolName}, then run the scheduler again.`,
      }
    case 'window_too_short_for_match':
      return {
        sentence: `${reason.poolName}'s ${reason.windowStart}–${reason.windowEnd} window is too short for a best-of-${reason.bestOf} match — it needs ${reason.neededMin} min but the window is only ${reason.windowSpanMin}.`,
        remedy: `Widen ${reason.poolName}'s window, or use a shorter match format.`,
      }
    case 'pool_over_capacity':
      return {
        sentence: `${reason.poolName} can't fit all its matches: they need about ${fmtTableTime(reason.requiredMin)} of table-time, but its ${reason.windowStart}–${reason.windowEnd} window on ${fmtTables(reason.tableCount)} only holds about ${fmtTableTime(reason.capacityMin)}.`,
        remedy: `Add a table to ${reason.poolName}, widen its window, or trim the field.`,
      }
    case 'player_over_subscribed':
      // The ticket's headline example, in the director's words: "player X is in 4
      // matches inside a 90-minute window". Both figures go through the shared
      // `fmtTableTime`, which owns the hour/minute rounding and leaves "about" to
      // this sentence. `matchCount` is always ≥2 — a lone fixture that cannot fit
      // is `window_too_short_for_match`'s finding, so the API never emits this arm
      // with one match and the plural is safe.
      return {
        sentence: `${reason.playerName} is in ${reason.matchCount} matches inside ${reason.poolName}'s ${reason.windowStart}–${reason.windowEnd} window — playing one at a time, with a rest between, they need about ${fmtTableTime(reason.requiredMin)}, but the window is only ${fmtTableTime(reason.windowSpanMin)} long.`,
        // NOT "add tables": a table is parallelism, and one human cannot play two
        // matches at once, so a second table would relieve nothing here (the same
        // trap `no_single_cause`'s remedy avoids, for a different reason).
        remedy: `Give ${reason.playerName} fewer matches in ${reason.poolName} — a smaller pool, or a shorter match format — or widen its window; adding tables won't help one player.`,
      }
    case 'unplaceable_fixtures': {
      // The conflict core, said in matchups — WHICH matches form the timing
      // conflict, which is the whole point of the arm. Every fixture is named,
      // conjoined the way `placementConflictSentence` names its colliding matches
      // (the existing pattern for a fixture list); nothing is elided behind an
      // "and N more", because a director cannot act on a set they can only see
      // part of — and a truncated list would read as *the* set, which is exactly
      // the claim this arm may not make.
      const matches = conjoinWithAnd(reason.fixtures.map(conflictFixtureLabel))
      const one = reason.fixtures.length === 1
      return {
        // NEVER "you must remove exactly these" / "the minimum set is": the core
        // is the drop set of a capped optimization, so "the rest fits without
        // them" is an upper bound that holds whether the solver proved optimality
        // or ran out of time, and the "not necessarily the smallest" clause keeps
        // the honest half of that on screen.
        sentence: one
          ? `1 match couldn't be placed: ${matches} — the rest of the day fits without it, though freeing it up isn't necessarily the only way to make the day work.`
          : `${reason.fixtures.length} matches couldn't all be placed: ${matches} — the rest of the day fits once they're out of it, though they aren't necessarily the smallest set to change.`,
        // NOT "add tables": every capacity pre-check passed before this arm was
        // reached, so there is table-time to spare and the obstacle is
        // arrangement — the same trap `no_single_cause`'s remedy avoids, worded
        // consistently with it.
        remedy: one
          ? `Trim this match from the field, widen its pool's window, or split the event across days — adding tables won't help here.`
          : `Trim one of these matches from the field, widen its pool's window, or split the event across days — adding tables won't help here.`,
      }
    }
    case 'no_single_cause':
      return {
        sentence: `There's enough total table-time (about ${fmtTableTime(reason.availableMin)} available for about ${fmtTableTime(reason.requiredMin)} of matches), so this is a timing conflict — a player is in too many matches too close together, or tables are shared across overlapping windows.`,
        remedy: `Trim a field, widen a window, or split the event across days — adding tables won't help here.`,
      }
    case 'past_window':
      // The venue-local `date` is formatted through the tournament's own date
      // formatter (`fmtDate`, tz-safe local-midnight — no hand-slicing, no drift),
      // so the director sees which day to move (ADR "a past day is named").
      return {
        sentence: `This event is dated in the past (${fmtDate(reason.date)}), so it can't be scheduled.`,
        remedy: `Move the event to a future date, then run the scheduler again.`,
      }
    default: {
      const exhaustive: never = reason
      return exhaustive
    }
  }
}

/** A stable-enough React key for one infeasibility reason: its `kind`, the pool
 * it names when it has one, and the list index (two `no_single_cause`s never
 * coexist, but the index keeps the key total). Shared so every surface that
 * lists the reasons keys them the same way by import, not by convention. */
export function infeasibilityReasonKey(reason: InfeasibilityReason, i: number): string {
  return 'poolName' in reason
    ? `${reason.kind}:${reason.poolName}:${i}`
    : `${reason.kind}:${i}`
}

// ----- copy: the placement conflicts → the director's words -------------------
//
// ONE shared module, in the spirit of `infeasibilityReasonCopy`: both the
// Schedule-tab solve strip and the admin solve ledger import
// `placementConflictSentence` and render the SAME warning, so the two surfaces
// cannot drift on how a conflict reads. Pure functions, unit-tested here.

/** One conflict as the director's caution sentence, naming the colliding matches
 * and the shared resource: `crafty-vs-spiked and dazed-vs-confused overlap on
 * Table 1` (table) / `… overlap on spiked-frigatebird` (human). Exhaustive over
 * `kind` — a `never` default makes a third arm a compile error until it has
 * words, so a conflict can never reach the UI as a blank line. */
export function placementConflictSentence(conflict: PlacementConflict): string {
  const matches = conjoinWithAnd(conflict.fixtures.map(conflictFixtureLabel))
  switch (conflict.kind) {
    case 'table_conflict':
      return `${matches} overlap on ${conflict.tableLabel}`
    case 'player_conflict':
      return `${matches} overlap on ${conflict.playerName}`
    default: {
      const exhaustive: never = conflict
      return exhaustive
    }
  }
}

/** A stable-enough React key for one placement conflict: its `kind`, the resource
 * it names, and the list index. Shared so every surface that lists the conflicts
 * keys them the same way by import, not by convention. */
export function placementConflictKey(conflict: PlacementConflict, i: number): string {
  const resource =
    conflict.kind === 'table_conflict' ? conflict.tableLabel : conflict.playerName
  return `${conflict.kind}:${resource}:${i}`
}

// ----- polling ----------------------------------------------------------------

/** The fast clip: a solve is in flight, and the strip should resolve promptly
 * after Run scheduler (the worker's runs are seconds, not minutes). */
export const SOLVE_IN_FLIGHT_POLL_MS = 3_000
/** The ambient clip while the tournament is live: matches finish and the solver
 * re-plans behind this page's back, so the schedule refreshes on its own. */
export const LIVE_POLL_MS = 15_000

/**
 * How often the Schedule tab's detail query refetches, or `false` for not at all.
 *
 * Two gears, in priority order: **in-flight beats live** — while a solve is
 * `queued`/`running` the poll runs at ~3s *whatever the tournament's status*
 * (pre-live solves are the point of infeasibility, and the director who clicked
 * Run is watching the strip), and while the tournament is `live` it idles at ~15s
 * so completions and re-solves arrive unprompted. Otherwise no polling: a draft's
 * schedule changes only under the director's own hands.
 *
 * Pure — tested as a function (`./solve.test.ts`), not through timers.
 */
export function scheduleRefetchInterval(
  status: TournamentStatus | undefined,
  solve: ScheduleSolve | null,
): number | false {
  if (solveInFlight(solve)) return SOLVE_IN_FLIGHT_POLL_MS
  if (status === 'live') return LIVE_POLL_MS
  return false
}

// ----- the Run-scheduler refusals ---------------------------------------------

/** The one coded refusal the route sends (ADR-0968 shape:
 * `{"detail": {"code", "message"}}`): nothing anywhere is drawn, so there is
 * nothing to place. Parsed, not matched on prose (`./entry-refusal` precedent). */
const noDrawnEventsBodySchema = z.object({
  detail: z.object({ code: z.literal('no_drawn_events') }),
})

/** What a refused run looks like to the director, inline on the strip. */
export interface RunSchedulerNotice {
  title: string
  description: string
}

/** The client's copy for every way `POST …/schedule/solves` fails — each a
 * designed notice, never the server's prose (`DEFINITION_OF_COMPLETE.md`).
 *
 * - **422 `no_drawn_events`** — the designed “cut a draw first” state, not an
 *   error in any real sense: the page simply got ahead of the draws.
 * - **403** — not the owner. The button is not offered to a non-owner, so this is
 *   a stale or forged view; say who may, not what went wrong.
 * - **503** — the queue was unreachable, nothing was queued, retrying is safe —
 *   which is exactly what the notice says.
 * - **status 0** — the network, per the repo's taxonomy: the server was never
 *   reached, and the copy must not claim otherwise.
 * - anything else — the honest generic, retry included.
 */
export function runSchedulerNotice(error: unknown): RunSchedulerNotice {
  if (error instanceof ApiError) {
    if (
      error.status === 422 &&
      noDrawnEventsBodySchema.safeParse(error.body).success
    ) {
      return {
        title: 'Nothing to schedule yet',
        description:
          "The scheduler places a draw's matches onto tables. Cut at least one event's draw, then run it.",
      }
    }
    if (error.status === 403) {
      return {
        title: "The scheduler wasn't run",
        description: 'Only the tournament owner can run the scheduler.',
      }
    }
    if (error.status === 503) {
      return {
        title: 'The scheduler is unavailable right now',
        description:
          'The scheduling queue could not be reached, so nothing was queued. Try again in a moment.',
      }
    }
    if (error.status === 0) {
      return {
        title: "Couldn't reach the server",
        description: 'Check your connection and run the scheduler again.',
      }
    }
  }
  return {
    title: "Couldn't run the scheduler",
    description: 'Something went wrong on our side. Try again in a moment.',
  }
}
