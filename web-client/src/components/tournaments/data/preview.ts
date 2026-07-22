// The **schedule preview** boundary (ADR "a schedule preview is a non-persistent
// solve over a synthetic field"): the client data layer for the three ephemeral
// preview endpoints —
//
//   POST   …/schedule/preview           → enqueue (token + instant structure)
//   GET    …/schedule/preview/{token}   → poll (status, and the result when done)
//   DELETE …/schedule/preview/{token}   → best-effort cancel
//
// A preview is transport-neutral and the browser POLLS it (the ADR "HTTP polls,
// MCP waits"): enqueue returns a token immediately with the immediately-known
// structure (the synthetic field sizes and the drawn fixtures, so the modal
// renders the field + grid skeleton from the first frame), and the poll query
// streams the solve in — `queued`/`running` while the worker chews, then `done`
// with the `PreviewResult`, or `failed`.
//
// Why a Zod parse and not just the generated types: the same answer the rest of
// this directory gives (`./solve`, `./fixtures`, `.claude/rules/parse-at-boundaries.md`).
// `schema.d.ts` is a compile-time claim; the network is untrusted, and the modal
// switches on `status` / `verdict` by VALUE — so an enum member this client does
// not know must fail HERE, inside the queryFn, not fall out of a `switch` in the
// modal as a blank panel. The infeasibility reasons ride the SAME discriminated
// union a real infeasible solve records, so they parse through `./solve`'s
// `infeasibilityReasonSchema` — one boundary, shared by both surfaces.

import { queryOptions, useMutation } from '@tanstack/react-query'
import { z } from 'zod'

import { api, unwrap } from '@/api/client'
import type { components } from '@/api/schema'

import { type InfeasibilityReason, infeasibilityReasonSchema } from './solve'

type PreviewEnqueuedWire = components['schemas']['PreviewEnqueued']
type PreviewFieldSummaryWire = components['schemas']['PreviewFieldSummary']
type PreviewFixtureWire = components['schemas']['PreviewFixture']
type PreviewEventBreakdownWire = components['schemas']['PreviewEventBreakdown']
type PreviewRequest = components['schemas']['PreviewRequest']

/** The four job states a poller can see (`PreviewJobStatus`): `queued` (waiting
 * for a worker slot, maybe behind an in-flight real solve), `running` (the CP-SAT
 * solve is under way), `done` (the result is ready), `failed` (the job errored,
 * was cancelled, or its short-TTL result expired out of Redis). `satisfies` pins
 * this closed set to the generated schema, so a status added to the API is a
 * compile error here until it is handled. */
const PREVIEW_JOB_STATUSES = [
  'queued',
  'running',
  'done',
  'failed',
] as const satisfies readonly components['schemas']['PreviewJobStatus'][]

/** The preview's four verdicts (`PreviewVerdict`): `optimal`/`feasible` fit,
 * `infeasible` is a *proof* it cannot fit (a designed pre-live outcome, not an
 * error), and `unknown` is "the cap ran out before an answer" — never "your day
 * doesn't fit". */
const PREVIEW_VERDICTS = [
  'optimal',
  'feasible',
  'infeasible',
  'unknown',
] as const satisfies readonly components['schemas']['PreviewVerdict'][]

export const previewJobStatusSchema = z.enum(PREVIEW_JOB_STATUSES)
export const previewVerdictSchema = z.enum(PREVIEW_VERDICTS)

export type PreviewJobStatus = z.infer<typeof previewJobStatusSchema>
export type PreviewVerdict = z.infer<typeof previewVerdictSchema>

// ----- the instant structure: field sizes + drawn fixtures --------------------

/** One event's synthetic field size — the count the preview drew a field to (an
 * override, the event's cap, or the uncapped default). Known the instant the
 * enqueue returns, so the modal names the fake counts per event before the solve
 * lands. */
export interface PreviewFieldSummary {
  eventId: string
  fieldSize: number
}

/** One drawn synthetic pairing, known the instant the draw runs (before the solve
 * returns) so the modal renders the grid skeleton immediately. Both sides are
 * always known (the pool stage of a round-robin draw); the synthetic ids are
 * opaque stand-ins the surface shows as `Placeholder N`.
 *
 * `poolId` is the namespaced `{event_id}:{pool_id}` composite the solver keys a
 * pool by (unique across events); `poolName` is the human label from the event's
 * pool config (e.g. `"Pool A"`) — the one the grid heads a column with, so a
 * director reads a name, not the raw composite. */
export interface PreviewFixture {
  fixtureId: string
  eventId: string
  poolId: string
  poolName: string
  playerAId: string
  playerBId: string
}

const previewFieldSummaryWireSchema = z.object({
  event_id: z.string(),
  field_size: z.number().int(),
}) satisfies z.ZodType<PreviewFieldSummaryWire>

const previewFixtureWireSchema = z.object({
  fixture_id: z.string(),
  event_id: z.string(),
  pool_id: z.string(),
  pool_name: z.string(),
  player_a_id: z.string(),
  player_b_id: z.string(),
}) satisfies z.ZodType<PreviewFixtureWire>

function previewFieldSummaryFromWire(
  s: PreviewFieldSummaryWire,
): PreviewFieldSummary {
  return { eventId: s.event_id, fieldSize: s.field_size }
}

function previewFixtureFromWire(f: PreviewFixtureWire): PreviewFixture {
  return {
    fixtureId: f.fixture_id,
    eventId: f.event_id,
    poolId: f.pool_id,
    poolName: f.pool_name,
    playerAId: f.player_a_id,
    playerBId: f.player_b_id,
  }
}

/** What the enqueue verb hands back the instant a preview is requested: the
 * `token` addressing the ephemeral job (poll it for the result), plus the
 * immediately-known structure so the modal is never a blank spinner (ADR "instant
 * structure and a streamed solve"). */
export interface PreviewEnqueued {
  token: string
  fieldSummaries: PreviewFieldSummary[]
  fixtures: PreviewFixture[]
}

export const previewEnqueuedWireSchema = z.object({
  token: z.string(),
  field_summaries: z.array(previewFieldSummaryWireSchema),
  fixtures: z.array(previewFixtureWireSchema),
}) satisfies z.ZodType<PreviewEnqueuedWire>

function previewEnqueuedFromWire(
  e: z.infer<typeof previewEnqueuedWireSchema>,
): PreviewEnqueued {
  return {
    token: e.token,
    fieldSummaries: e.field_summaries.map(previewFieldSummaryFromWire),
    fixtures: e.fixtures.map(previewFixtureFromWire),
  }
}

export const previewEnqueuedSchema =
  previewEnqueuedWireSchema.transform(previewEnqueuedFromWire)

/** Parse the 202 enqueue body, or throw. `unknown` on purpose — the generated
 * type is exactly the claim this checks (`.claude/rules/parse-at-boundaries.md`). */
export function parsePreviewEnqueued(input: unknown): PreviewEnqueued {
  return previewEnqueuedSchema.parse(input)
}

// ----- the result: verdict-first, then the day's shape ------------------------

/** One event's contribution to the preview summary: the drawn match count (stable
 * regardless of verdict — the draw always completes), the round-robin bye count,
 * and the event's own makespan span in minutes (`null` when the solve produced no
 * plan — infeasible/unknown — where there is nothing to span). */
export interface PreviewEventBreakdown {
  eventId: string
  name: string
  matches: number
  byes: number
  durationMin: number | null
}

const previewEventBreakdownWireSchema = z.object({
  event_id: z.string(),
  name: z.string(),
  matches: z.number().int(),
  byes: z.number().int(),
  duration_min: z.number().nullable(),
}) satisfies z.ZodType<PreviewEventBreakdownWire>

function previewEventBreakdownFromWire(
  e: PreviewEventBreakdownWire,
): PreviewEventBreakdown {
  return {
    eventId: e.event_id,
    name: e.name,
    matches: e.matches,
    byes: e.byes,
    durationMin: e.duration_min,
  }
}

/**
 * A schedule preview's whole answer, in the domain's camelCase — verdict-first,
 * then the day's shape.
 *
 * `fits` is the server-derived headline (a pure function of `verdict`, carried so
 * the two can never drift). `estimatedDurationMin` is the day's makespan in
 * minutes and `estimatedFinish` its wall-clock form (both `null` when there is no
 * plan). `infeasibilityReasons` is the resolved, machine-readable "why it doesn't
 * fit" — the SAME discriminated union a real infeasible solve records — and is
 * **always a list** (`[]` when it fits). `notes` is the always-present honest-notes
 * strip (at minimum the disjoint-field caveat and the synthetic counts assumed):
 * a preview is optimistic by construction, and that floor is surfaced, not hidden.
 */
export interface PreviewResult {
  verdict: PreviewVerdict
  fits: boolean
  estimatedDurationMin: number | null
  estimatedFinish: string | null
  totalMatches: number
  totalByes: number
  peakConcurrentTables: number
  tableUtilization: number
  events: PreviewEventBreakdown[]
  infeasibilityReasons: InfeasibilityReason[]
  notes: string[]
}

/** The wire shape (`PreviewResult`), as it really arrives: snake_case, the reasons
 * parsed through `./solve`'s discriminated union so an unknown reason `kind` fails
 * the whole result (not blank a row two components later). No whole-object
 * `satisfies` — the reasons element transforms snake→camel, so the object's output
 * type is the domain's, not the wire's; the field-name pinning is done by the
 * `: PreviewResult` return annotation on the mapper below. */
export const previewResultWireSchema = z.object({
  verdict: previewVerdictSchema,
  fits: z.boolean(),
  estimated_duration_min: z.number().nullable(),
  estimated_finish: z.string().nullable(),
  total_matches: z.number().int(),
  total_byes: z.number().int(),
  peak_concurrent_tables: z.number().int(),
  table_utilization: z.number(),
  events: z.array(previewEventBreakdownWireSchema),
  // Always present (a non-nullable list); each element parsed through the
  // discriminated union, so an unknown arm `kind` fails the whole result.
  infeasibility_reasons: z.array(infeasibilityReasonSchema),
  notes: z.array(z.string()),
})

function previewResultFromWire(
  r: z.infer<typeof previewResultWireSchema>,
): PreviewResult {
  return {
    verdict: r.verdict,
    fits: r.fits,
    estimatedDurationMin: r.estimated_duration_min,
    estimatedFinish: r.estimated_finish,
    totalMatches: r.total_matches,
    totalByes: r.total_byes,
    peakConcurrentTables: r.peak_concurrent_tables,
    tableUtilization: r.table_utilization,
    events: r.events.map(previewEventBreakdownFromWire),
    // Already snake→camel-mapped by `infeasibilityReasonSchema`'s transform.
    infeasibilityReasons: r.infeasibility_reasons,
    notes: r.notes,
  }
}

export const previewResultSchema =
  previewResultWireSchema.transform(previewResultFromWire)

// ----- the poll: a single read of the job's state -----------------------------

/**
 * A single read of a preview job's status by token — the boundary value the poll
 * query resolves to. `result` is set only on `done`, `error` only on `failed`
 * (the server's constructor guarantees it), so the modal switches on `status` and
 * reads whichever the state carries.
 *
 * Both `result` and `error` are `.nullable()` and defaulted, never merely
 * `.optional()`: an absent key and an explicit `null` mean the same designed thing
 * ("this stage carries no result/error"), so we normalise both to `null` and let
 * the modal branch on `status`, not on which field happens to be present.
 */
export interface PreviewJobState {
  status: PreviewJobStatus
  result: PreviewResult | null
  error: string | null
}

export const previewJobStateSchema = z
  .object({
    status: previewJobStatusSchema,
    result: previewResultSchema.nullish().transform((r) => r ?? null),
    error: z.string().nullish().transform((e) => e ?? null),
  })
  .transform(
    (s): PreviewJobState => ({
      status: s.status,
      result: s.result,
      error: s.error,
    }),
  )

/** Parse a poll body, or throw. */
export function parsePreviewJobState(input: unknown): PreviewJobState {
  return previewJobStateSchema.parse(input)
}

// ----- polling ----------------------------------------------------------------

/** How often the modal re-reads an in-flight preview job. The solve runs on a
 * worker behind the modal's back and its finish is not an event this client is
 * told about, so it polls — briskly, because the director who clicked Preview is
 * watching the panel and the preview cap is a few seconds. */
export const PREVIEW_POLL_MS = 700

/** True while a preview job is still on the queue or the solver — the state the
 * modal shows a labeled wait for, and the state the poll keeps polling in. */
export function previewInFlight(status: PreviewJobStatus | undefined): boolean {
  return status === 'queued' || status === 'running'
}

/**
 * The poll's `refetchInterval`, as a pure function of the last-seen status:
 * `PREVIEW_POLL_MS` while the job is `queued`/`running`, and `false` (stop) once
 * it is `done`/`failed` — a terminal job never changes again, so there is nothing
 * left to poll for. `undefined` (no read yet) keeps polling so the first poll is
 * scheduled. Pure, so it is unit-tested rather than asserted through timers.
 */
export function previewPollInterval(
  status: PreviewJobStatus | undefined,
): number | false {
  if (status === undefined) return PREVIEW_POLL_MS
  return previewInFlight(status) ? PREVIEW_POLL_MS : false
}

// ----- query keys -------------------------------------------------------------

/** The only place a preview poll's key is spelled — hierarchical, so a token's
 * cache is addressable and a whole tournament's previews invalidate together if
 * they ever need to. */
export const schedulePreviewQueryKey = (
  tournamentId: string,
  token: string | null,
) =>
  [
    {
      scope: 'tournaments',
      version: 'v1',
      entity: 'schedule-preview',
      tournamentId,
      token,
    },
  ] as const

// ----- the poll query ---------------------------------------------------------

/**
 * The poll query options for one enqueued preview: `GET …/schedule/preview/{token}`,
 * parsed at the boundary, with a `refetchInterval` that keeps polling while the
 * job is `queued`/`running` and stops on `done`/`failed`. This is the streamed-
 * solve mechanism the modal consumes — mount it with the token the enqueue
 * returned and read `data.status` / `data.result`.
 *
 * `enabled` gates on the token: passing `null` (no preview enqueued yet) leaves the
 * query idle rather than firing a tokenless request. `retry: false` — a preview is
 * advisory and a failed poll should surface promptly, not after a backoff storm.
 */
export function schedulePreviewQueryOptions(
  tournamentId: string,
  token: string | null,
) {
  return queryOptions({
    queryKey: schedulePreviewQueryKey(tournamentId, token),
    queryFn: async (): Promise<PreviewJobState> => {
      // The `enabled` guard below keeps this from running with a null token; the
      // throw is a belt so a misconfigured caller fails loudly, not silently.
      if (token === null) throw new Error('no schedule-preview token')
      const state = unwrap(
        'read the schedule preview',
        await api.GET(
          '/v1/tournaments/{tournament_id}/schedule/preview/{token}',
          { params: { path: { tournament_id: tournamentId, token } } },
        ),
      )
      // Untrusted like every other payload — parse it, don't cast it.
      return parsePreviewJobState(state)
    },
    enabled: token !== null,
    refetchInterval: (query) => previewPollInterval(query.state.data?.status),
    retry: false,
  })
}

// ----- the enqueue + cancel mutations -----------------------------------------

/** The enqueue mutation's variable: an optional per-event field-size override map
 * (`{ [eventId]: count }`) the director explores a "what if N show up" scenario
 * with. Omitted events fill to their own cap (or the uncapped default), so the
 * whole thing — and the request body — is optional. */
export interface EnqueueSchedulePreviewInput {
  overrides?: Record<string, number>
}

/**
 * Enqueue a schedule preview — the owner's **Preview schedule** button:
 * `POST /v1/tournaments/{id}/schedule/preview`, with the optional per-event
 * overrides. Owner-gated and pre-live-only on the server; the 202 hands back the
 * `token` and the instant structure (parsed), which the caller feeds to
 * `schedulePreviewQueryOptions` to start polling.
 *
 * No cache invalidation: a preview persists nothing and has no cache entry to
 * stale (ADR "persisting nothing"). The result streams in over the poll, not
 * through this mutation.
 */
export function useEnqueueSchedulePreview(tournamentId: string) {
  return useMutation({
    mutationFn: async (
      input: EnqueueSchedulePreviewInput = {},
    ): Promise<PreviewEnqueued> => {
      const body: PreviewRequest = input.overrides
        ? { overrides: input.overrides }
        : {}
      const enqueued = unwrap(
        'request the schedule preview',
        await api.POST('/v1/tournaments/{tournament_id}/schedule/preview', {
          params: { path: { tournament_id: tournamentId } },
          body,
        }),
      )
      // Untrusted like every other payload — parse it, don't cast it.
      return parsePreviewEnqueued(enqueued)
    },
  })
}

/**
 * Cancel an enqueued preview by token — best-effort:
 * `DELETE …/schedule/preview/{token}`, a bodiless 204. The modal fires this on
 * close to reclaim the worker's single throttled slot (ADR "cancel-on-close"), so
 * it is **fire-and-forget friendly**: a failed cancel is harmless (the job's
 * timeout + short TTL bound the waste), and this mutation carries no global error
 * toast — the caller may ignore the result entirely.
 */
export function useCancelSchedulePreview(tournamentId: string) {
  return useMutation({
    mutationFn: async (token: string): Promise<void> => {
      unwrap(
        'cancel the schedule preview',
        await api.DELETE(
          '/v1/tournaments/{tournament_id}/schedule/preview/{token}',
          { params: { path: { tournament_id: tournamentId, token } } },
        ),
        { allowEmpty: true },
      )
    },
  })
}
