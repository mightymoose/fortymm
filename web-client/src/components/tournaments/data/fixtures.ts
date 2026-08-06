// The **fixtures** boundary (ADR-0786): where an event's draw stops being bytes off
// the wire and becomes a typed domain value.
//
// A fixture is one planned pairing of a draw — a round and a position (plus a pool,
// when the draw is pooled) — whose sides may still be TBD. It is NOT a match; it
// materializes into one later (#788), and until then its `matchId` is `null`.
//
// Why a Zod parse and not just the generated types: `schema.d.ts` is a *compile-time*
// claim about what the server sends (root `CLAUDE.md`), and `api.GET` casts the decoded
// JSON to it without looking. The network is untrusted
// (`.claude/rules/parse-at-boundaries.md`), so the fixtures are **parsed** here, at the
// fetch boundary, and only the parsed value travels inward. A fixture missing its
// `round`, or carrying a `pool_id` that is a number, fails HERE — loudly, in the
// queryFn, before it can prime the cache — rather than surfacing three components
// later as a `undefined` in a bracket header.
//
// **Every `null` on a fixture is a fact, not a missing field**, and the schema says so
// with `.nullable()` (which demands the key be *present*) rather than `.optional()`
// (which would let it be absent): `entryAId`/`entryBId` null means **TBD** — the side
// is not known yet and `advance()` will fill it — and a payload that simply omitted a
// side would be a payload we cannot tell apart from one that means TBD. A bye is the
// ABSENCE OF A FIXTURE, never a fixture with an empty side, so there is no third state
// hiding in that null.

import { z } from 'zod'

import type { MatchStatus } from '@/api/matches'

import type { Fixture, FixtureTime } from './types'

/** The four match statuses, as the wire's `MatchStatus` enum spells them. `satisfies
 * readonly MatchStatus[]` guards against a typo — every literal here must be a real
 * `MatchStatus` — so this closed set and the generated `schema.d.ts` cannot drift into a
 * status the app accepts but the server never sends (or vice versa). Exported because a
 * materialized fixture is not the only place a status crosses the boundary (Slice 2's
 * standings will want it too). */
const MATCH_STATUSES = [
  'pending',
  'in_progress',
  'completed',
  'voided',
] as const satisfies readonly MatchStatus[]

export const matchStatusSchema = z.enum(MATCH_STATUSES)

/** The wire shape of one displayed time (`FixtureTimeRead`, ADR "tournament times are
 * timezone-aware instants"): the server did all the timezone arithmetic, so this is three
 * plain strings — a UTC `instant` for geometry, a venue-local 12-hour `local_label`, and
 * its DST-correct `tz_abbrev`. Parsed into the camelCase `FixtureTime` below; the field
 * that holds it is `.nullable()` (unassigned is a fact, present-but-null), never absent. */
const fixtureTimeWireSchema = z.object({
  instant: z.string(),
  local_label: z.string(),
  tz_abbrev: z.string(),
})

const fixtureTimeSchema = fixtureTimeWireSchema.transform(
  (t): FixtureTime => ({
    instant: t.instant,
    localLabel: t.local_label,
    tzAbbrev: t.tz_abbrev,
  }),
)

/** The wire shape (`TournamentFixtureRead`), as it really arrives: snake_case, with
 * five nullable columns that all mean something. Kept separate from the transform
 * below so the *runtime* contract is legible next to the generated type it mirrors. */
const fixtureWireSchema = z.object({
  id: z.string(),
  /** `null` = an un-pooled draw (single-elim, swiss), or the **knockout stage** of an
   * `rr-then-ko` one (#1227). It says the fixture belongs to no pool; it does NOT say
   * what the fixture *is* — the event's **draw type** answers that, which is why
   * `unpooledShape` (`./draw`) routes on the draw type rather than on this null.
   * When set it is a **string ref** into the event's own `pools` — not a foreign key,
   * because pools are JSONB value-objects (ADR-0786). */
  pool_id: z.string().nullable(),
  round: z.number().int(),
  position: z.number().int(),
  /** `null` = **TBD**, never a bye. */
  entry_a_id: z.string().nullable(),
  entry_b_id: z.string().nullable(),
  /** `null` while the fixture is undecided. */
  winner_entry_id: z.string().nullable(),
  /** `null` until the fixture materializes into a real match (#788). */
  match_id: z.string().nullable(),
  /** The materialized match's live status, or `null` when the fixture has not
   * materialized. Moves in lockstep with `match_id`. */
  match_status: matchStatusSchema.nullable(),
  /** The fixture's **placement** table (ADR-0790): `null` = **unassigned**. When
   * set it is a **string ref** into the tournament's `table_catalogue` — not a
   * foreign key, the same pattern as `pool_id`. */
  table_id: z.string().nullable(),
  /** The placement's **predicted** start (ADR "tournament times are timezone-aware
   * instants"): `null` = **unscheduled**. When set, a `FixtureTimeRead` — a venue-local
   * label + tz abbrev for display plus a raw UTC instant for geometry — a prediction, not
   * a commitment. */
  scheduled_start: fixtureTimeSchema.nullable(),
  /** When the fixture was **called** (ADR "the schedule is solved, the call is
   * pinned"): `null` = an estimate the solver may still move; set = a promise the
   * players were notified of. A `FixtureTimeRead`, like `scheduled_start`. */
  pinned_at: fixtureTimeSchema.nullable(),
  /** How many call/correction notifications this fixture's players have received —
   * `0` for a never-called fixture, never absent. */
  call_notified_count: z.number().int(),
  /** The match's **actual** completion time, as opposed to `scheduled_start`'s
   * *predicted* one: `null` until the match is actually decided (win or void).
   * A `FixtureTimeRead`, like `scheduled_start`/`pinned_at`. */
  completed_at: fixtureTimeSchema.nullable(),
})

/** The parser: one wire fixture → one domain `Fixture`.
 *
 * The transform is annotated `: Fixture` on purpose — that is what makes the domain
 * interface in `./types` and this schema one thing rather than two: drop a field from
 * either and this line is a compile error, so the runtime parser and the type the app
 * holds cannot drift apart. */
export const fixtureSchema = fixtureWireSchema.transform(
  (f): Fixture => ({
    id: f.id,
    poolId: f.pool_id,
    round: f.round,
    position: f.position,
    entryAId: f.entry_a_id,
    entryBId: f.entry_b_id,
    winnerEntryId: f.winner_entry_id,
    matchId: f.match_id,
    matchStatus: f.match_status,
    tableId: f.table_id,
    scheduledStart: f.scheduled_start,
    pinnedAt: f.pinned_at,
    callNotifiedCount: f.call_notified_count,
    completedAt: f.completed_at,
  }),
)

/** An event's whole draw. **`[]` is the designed "no draw cut yet" state** — never
 * `null`, and never an error: an event whose director has not cut a draw has an empty
 * fixture list, which is a data state the UI renders as such (`DEFINITION_OF_COMPLETE`:
 * "Empty is a designed data state, never a thrown one"). What is NOT tolerated is
 * `null`/absent: `.array()` refuses both, so a server that stopped sending the field is
 * a loud failure rather than a silently draw-less tournament. */
export const fixturesSchema = z.array(fixtureSchema)

/**
 * Parse an event's `fixtures` off the wire, or throw.
 *
 * Takes `unknown`, deliberately: the value it is handed is typed
 * `TournamentFixtureRead[]` by the generated schema, and that type is exactly the claim
 * this function exists to check. Accepting the typed shape would let the compiler talk
 * us out of the runtime guarantee.
 *
 * Throws a `ZodError`. It is called from the tournament queries' `queryFn`
 * (`./api.ts`), so a malformed draw fails the *query* — the error boundary gets it, the
 * cache is never primed with it, and no component ever sees a half-fixture.
 */
export function parseFixtures(input: unknown): Fixture[] {
  return fixturesSchema.parse(input)
}
