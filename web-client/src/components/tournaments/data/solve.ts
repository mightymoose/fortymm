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

import { fmtDate } from './helpers'
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

// ----- the named infeasibility reason: why "infeasible" specifically ----------
//
// An `infeasible` verdict is no longer always one opaque "the day doesn't fit".
// The API's solver pre-check distinguishes a *named* cause from a generic
// capacity shortfall (ADR "a past day is named, not disguised") and ships it on
// `ScheduleSolveRead.infeasible_reason`: `null` for every non-infeasible run AND
// for a generic capacity infeasibility (a current-but-too-tight window, no single
// named cause), non-null ONLY for a named cause. Today the sole named cause is
// `past_window` — a pool's ENTIRE planned window is already behind now — carrying
// the offending venue-local `date` (`YYYY-MM-DD`, resolved server-side in the
// event's own timezone frame, so the client does no tz math of its own).
//
// The `code` is *data* the strip switches on, so — like `status`/`trigger`/
// `verdict` — a code this client has no words for must FAIL the parse HERE, in the
// queryFn, not fall out of a `switch` two components later as a blank line
// (`z.discriminatedUnion` rejects an unknown discriminator). The *sentence* is
// still the client's, minted in `infeasibleReasonMessage` below.

type PastWindowReasonWire = components['schemas']['PastWindowReason']

/** The named cause of a `past_window` infeasibility, in the domain's spelling: a
 * pool's whole planned window is a day already behind now, so it cannot run until
 * it is moved to a future day. `code` is the machine-readable discriminator; `date`
 * is the offending venue-local calendar day (`YYYY-MM-DD`), which the strip names
 * so the director knows exactly which day to move. */
export interface PastWindowReason {
  code: 'past_window'
  date: string
}

/** The named infeasibility reason a solve can carry — a discriminated union over
 * `code`, one arm today (`past_window`). Modelled as a union (not a lone object)
 * so a second named cause added to the API is a compile error here until it is
 * given copy in `infeasibleReasonMessage`, never a raw code on screen. */
export type InfeasibleReason = PastWindowReason

/** The wire arm, as it really arrives — `code` a literal so the union can
 * discriminate on it. `satisfies` it against the generated schema so a field
 * renamed in the API is a compile error here, not a silent `undefined`. */
const pastWindowReasonWireSchema = z.object({
  code: z.literal('past_window'),
  date: z.string(),
}) satisfies z.ZodType<PastWindowReasonWire>

/** The named reason as one `z.discriminatedUnion('code', …)` — an unknown `code`
 * has no arm and throws, which is exactly the boundary rule: a reason this client
 * cannot render must fail the parse, not blank the line. `date` is single-word, so
 * the domain shape equals the wire shape (no snake→camel mapping needed). */
export const infeasibleReasonSchema = z.discriminatedUnion('code', [
  pastWindowReasonWireSchema,
])

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
  /** The named, machine-readable cause of an `infeasible` verdict, or `null`.
   * `null` for every non-infeasible run AND for a generic capacity infeasibility
   * (a current-but-too-tight window, no single named cause); non-null only for a
   * named cause — today, a `past_window` naming the offending venue-local day
   * (ADR "a past day is named, not disguised"). Not a stage marker: it is the
   * *why* behind one specific status, and an absent key is a payload we reject. */
  infeasibleReason: InfeasibleReason | null
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
  // Present on every row (a nullable, never optional — an absent key is a payload
  // we reject, not a "generic infeasibility"); non-null only for a named cause,
  // parsed through the discriminated union so an unknown `code` fails the row.
  infeasible_reason: infeasibleReasonSchema.nullable(),
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
    // Domain shape equals the wire shape (single-word fields), so it carries
    // straight through — already parsed by `infeasibleReasonSchema`.
    infeasibleReason: s.infeasible_reason,
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
      /** The named cause when there is one — today only `past_window` (the event's
       * whole planned window is a day already behind now), which the strip renders
       * as a *specific, dated* message instead of the generic "doesn't fit". `null`
       * for a generic capacity infeasibility, which keeps the generic message. */
      reason: InfeasibleReason | null
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
        reason: solve.infeasibleReason,
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

/**
 * The specific, actionable sentence for a *named* infeasibility reason — the
 * client's own copy (raw wire strings never reach the UI), naming the offending
 * day so the director knows exactly what to fix (ADR "a past day is named, not
 * disguised"). The venue-local `date` is formatted through the tournament's own
 * date formatter (`fmtDate`, tz-safe local-midnight — no hand-slicing, no drift).
 *
 * Exhaustive over `code` — a `never` default makes a second named cause added to
 * the API a compile error here until it has words, so a reason can never reach the
 * UI as a blank line. A generic infeasibility carries `null` and never reaches
 * here: the strip keeps its generic "the day doesn't fit" copy for that case.
 */
export function infeasibleReasonMessage(reason: InfeasibleReason): string {
  switch (reason.code) {
    case 'past_window':
      return `This event's window (${fmtDate(reason.date)}) has already passed — update the date.`
    default: {
      const exhaustive: never = reason.code
      return exhaustive
    }
  }
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
