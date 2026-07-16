// The **admin solve ledger** boundary: where `/v1/admin/schedule-solves` stops
// being bytes off the wire and becomes typed domain values — the Administration
// area's read of the `schedule_solves` run ledger, verbatim (ADR "the schedule
// is solved; the call is pinned").
//
// Why a Zod parse and not just the generated types: same answer as
// `../tournaments/data/solve.ts`, whose enum schemas this module REUSES rather
// than re-spelling. `schema.d.ts` is a compile-time claim, the network is
// untrusted (`.claude/rules/parse-at-boundaries.md`), and the table switches on
// `status` / `trigger` / `verdict` by value — an enum member this client does
// not know must fail HERE, inside the queryFn, not fall out of a `switch` as an
// unrenderable row.
//
// INVALIDATION MAP — this page is READ-ONLY: the module carries no mutations,
// so nothing anywhere invalidates `adminScheduleSolvesQueryKey`. Freshness
// comes from navigation (each page/filter is its own key) and the app default
// staleTime; a mutation elsewhere that ever starts writing solve rows
// client-side must add its invalidation here and to this note.

import { queryOptions } from '@tanstack/react-query'
import { z } from 'zod'

import { api, unwrap } from '@/api/client'
import type { components } from '@/api/schema'
import {
  scheduleSolveFromWire,
  scheduleSolveWireSchema,
  type ScheduleSolve,
} from '@/components/tournaments/data/solve'

type AdminScheduleSolveWire = components['schemas']['AdminScheduleSolveRead']

/** The roster's pagination contract, as the endpoint defaults it
 * (`api/app/admin_schedule_solves.py:LIST_DEFAULT_PAGE_SIZE`). */
export const SOLVE_LEDGER_PAGE_SIZE = 25

/**
 * The `?page=` / `?tournament=` search params, parsed at the route boundary
 * (`web-client/CLAUDE.md § Boundaries`). Junk falls back to the default via
 * `.catch(undefined)` — the `/players` precedent — so a mangled URL renders
 * page 1, unfiltered, instead of throwing.
 *
 * `tournament` is deliberately a plain trimmed string, not `.uuid()`: the
 * client only ever writes a `tournament_id` it was handed by a ledger row, and
 * the server owns the uuid validation (a hand-mangled value 422s there and
 * surfaces through the admin boundary's retryable error state). Requiring a
 * uuid here would also break the mock world, whose seeded tournament ids are
 * readable slugs.
 */
export const solveLedgerSearchSchema = z.object({
  page: z.coerce.number().int().min(2).optional().catch(undefined),
  tournament: z.string().trim().min(1).max(64).optional().catch(undefined),
})

export type SolveLedgerSearch = z.infer<typeof solveLedgerSearchSchema>

/**
 * One ledger row as the **admin** page holds it: everything the
 * tournament-facing `ScheduleSolve` carries, plus the operator-only facts that
 * read omits. Each `null` is a fact, never a missing field:
 * `inputFingerprint` null = the run never snapshotted its inputs;
 * `rerunRequested` is the coalescer's second arm (a trigger landed while the
 * run was `running` — meaningless, always false, on terminal rows).
 */
export interface AdminScheduleSolve extends ScheduleSolve {
  inputFingerprint: string | null
  rerunRequested: boolean
  tournamentId: string
  tournamentName: string
}

/** The wire shape (`AdminScheduleSolveRead`), as it really arrives: snake_case,
 * every nullable present (`.nullable()`, never `.optional()`). It IS the
 * tournament-facing wire schema plus the four operator-only fields —
 * `.extend()`ed from `../tournaments/data/solve.ts` rather than re-spelled, so
 * this parser cannot drift from that one (whose enum sets are pinned to the
 * generated schema with `satisfies`). */
const adminScheduleSolveWireSchema = scheduleSolveWireSchema.extend({
  input_fingerprint: z.string().nullable(),
  rerun_requested: z.boolean(),
  tournament_id: z.string(),
  tournament_name: z.string(),
})

// Compile-time tether: the runtime parser must accept exactly what the
// generated type says the server sends. Drop or misspell a field on either
// side and this line is a type error (the `data/solve.ts` pattern, both ways).
const _wireParity: AdminScheduleSolveWire extends z.input<
  typeof adminScheduleSolveWireSchema
>
  ? true
  : never = true
void _wireParity

/** The parser: one wire row → one domain `AdminScheduleSolve`. Annotated so the
 * interface above and this schema are one thing — drop a field from either and
 * this transform is a compile error. */
export const adminScheduleSolveSchema = adminScheduleSolveWireSchema.transform(
  (s): AdminScheduleSolve => ({
    ...scheduleSolveFromWire(s),
    inputFingerprint: s.input_fingerprint,
    rerunRequested: s.rerun_requested,
    tournamentId: s.tournament_id,
    tournamentName: s.tournament_name,
  }),
)

/** One page of the ledger, plus the pagination facts the footer needs. `total`
 * counts the rows matching the request's tournament filter, exactly as the
 * endpoint documents. */
export interface AdminSolveLedgerPage {
  items: AdminScheduleSolve[]
  page: number
  pageSize: number
  total: number
}

const adminSolveLedgerPageSchema = z
  .object({
    items: z.array(adminScheduleSolveSchema),
    page: z.number().int(),
    page_size: z.number().int(),
    total: z.number().int(),
  })
  .transform(
    (r): AdminSolveLedgerPage => ({
      items: r.items,
      page: r.page,
      pageSize: r.page_size,
      total: r.total,
    }),
  )

/** Parse the endpoint's list payload, or throw. `unknown` on purpose — the
 * generated type is exactly the claim this checks. */
export function parseAdminSolveLedgerPage(input: unknown): AdminSolveLedgerPage {
  return adminSolveLedgerPageSchema.parse(input)
}

export interface AdminSolveLedgerParams {
  page: number
  tournamentId?: string
}

/** Cache key — the whole params bag (normalized: absent filter is `null`), so
 * two filters keep separate slots and paging one doesn't blow the other away. */
export function adminScheduleSolvesQueryKey(params: AdminSolveLedgerParams) {
  return [
    'admin',
    'schedule-solves',
    { page: params.page, tournamentId: params.tournamentId ?? null },
  ] as const
}

/**
 * The paginated cross-tournament solve ledger backing `/admin/schedule-solves`
 * — the page's ONE endpoint (BFF rule), newest request first from the server.
 *
 * Shared by the page's `useSuspenseQuery` and the route loader's prefetch, so
 * an intent preload warms exactly the cache entry the component reads.
 *
 * `retry: false` is load-bearing twice over: the app's QueryClient sets no
 * retry (so the default of 3 would apply), and the interesting failure here is
 * a **403** from the server-side `scheduling.view` gate — which must reach the
 * admin `RbacBoundary`'s designed access-denied state immediately, not after
 * three identical refusals behind a skeleton.
 */
export function adminScheduleSolvesQueryOptions(params: AdminSolveLedgerParams) {
  return queryOptions({
    queryKey: adminScheduleSolvesQueryKey(params),
    queryFn: async (): Promise<AdminSolveLedgerPage> =>
      parseAdminSolveLedgerPage(
        unwrap(
          'load the solve ledger',
          await api.GET('/v1/admin/schedule-solves', {
            params: {
              query: {
                tournament_id: params.tournamentId,
                page: params.page,
                page_size: SOLVE_LEDGER_PAGE_SIZE,
              },
            },
          }),
        ),
      ),
    retry: false,
  })
}
