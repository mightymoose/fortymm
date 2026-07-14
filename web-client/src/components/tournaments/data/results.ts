// The **results** boundary (ADR-0788): where an event's standings stop being bytes off
// the wire and become a typed domain value.
//
// An event's results are its pool standings, whether the whole event is decided, and its
// champion — all derived *live* on the server from the fixtures' currently-completed
// matches (never a snapshot). This is the runtime parse that guards them, the twin of
// `./fixtures` for the draw.
//
// Why a Zod parse and not just the generated types: `schema.d.ts` is a *compile-time*
// claim about what the server sends (root `CLAUDE.md`), and `api.GET` casts the decoded
// JSON to it without looking. The network is untrusted
// (`.claude/rules/parse-at-boundaries.md`), so the results are **parsed** here, at the
// fetch boundary, and only the parsed value travels inward — a standings row missing its
// `wins`, or carrying a `rank` that is a string, fails HERE, in the queryFn, before it
// can prime the cache and surface three components later as a `NaN` in a table cell.
//
// **`results` is `.nullable()`, and the null is a FACT** (`.nullable()` demands the key be
// present, unlike `.optional()`): `null` means the event has no results to stand — it has
// no draw, or its draw type has no results strategy yet (only round-robin does today). An
// event whose payload simply *omitted* the field would be one we could not tell apart from
// one that means "no results", so the schema refuses the absent case and accepts only an
// explicit `null` or a real results object.

import { z } from 'zod'

import type { EventResults, PoolStandings, StandingRow } from './types'

/** The wire shape (`StandingRowRead`), snake_case, every field required — a standings row
 * has no nullable columns: an entry that has played nothing still has a row of zeroes, not
 * a row of nulls. `game_difference` arrives already reduced (`games_won - games_lost`),
 * computed once on the server so it cannot disagree with the two counts beside it; the
 * parse carries it through rather than re-deriving a second copy. */
const standingRowWireSchema = z.object({
  entry_id: z.string(),
  rank: z.number().int(),
  played: z.number().int(),
  wins: z.number().int(),
  losses: z.number().int(),
  games_won: z.number().int(),
  games_lost: z.number().int(),
  game_difference: z.number().int(),
})

/** One wire row → one domain `StandingRow`. Annotated `: StandingRow` on purpose — that
 * is what keeps the domain interface in `./types` and this schema one thing: drop a field
 * from either and this line is a compile error, so the runtime parser and the type the app
 * holds cannot drift apart. */
const standingRowSchema = standingRowWireSchema.transform(
  (r): StandingRow => ({
    entryId: r.entry_id,
    rank: r.rank,
    played: r.played,
    wins: r.wins,
    losses: r.losses,
    gamesWon: r.games_won,
    gamesLost: r.games_lost,
    gameDifference: r.game_difference,
  }),
)

/** The wire shape (`PoolStandingsRead`): a pool's rows **in the server's finishing order**
 * plus whether every one of its fixtures is decided. The order is untrusted like any other
 * data, but it is NOT re-sorted here (ADR-0788 — the order *is* the result); it is parsed
 * as given and carried inward unchanged. */
const poolStandingsWireSchema = z.object({
  pool_id: z.string(),
  rows: z.array(standingRowSchema),
  complete: z.boolean(),
})

const poolStandingsSchema = poolStandingsWireSchema.transform(
  (p): PoolStandings => ({
    poolId: p.pool_id,
    rows: p.rows,
    complete: p.complete,
  }),
)

/** The wire shape (`EventResultsRead`): the pools, whether the whole event is decided, and
 * its champion (an **entry id**, or `null`). */
const eventResultsWireSchema = z.object({
  pools: z.array(poolStandingsSchema),
  complete: z.boolean(),
  /** `null` while any fixture is unplayed, and for a multi-pool event, which has no single
   * champion without a knockout stage (a later slice). */
  champion: z.string().nullable(),
})

export const eventResultsSchema = eventResultsWireSchema.transform(
  (r): EventResults => ({
    pools: r.pools,
    complete: r.complete,
    champion: r.champion,
  }),
)

/** An event's `results`, or `null`. **`.nullable()`, never `.optional()`** — the key must
 * be present, and a `null` is the designed "no results here" state, not a missing field
 * (an event with no draw, or a draw type with no results strategy yet). */
export const resultsSchema = eventResultsSchema.nullable()

/**
 * Parse an event's `results` off the wire, or throw.
 *
 * Takes `unknown`, deliberately: the value it is handed is typed
 * `EventResultsRead | null` by the generated schema, and that type is exactly the claim
 * this function exists to check at runtime. Accepting the typed shape would let the
 * compiler talk us out of the runtime guarantee.
 *
 * Throws a `ZodError`. Called from the tournament queries' `queryFn` (via `apiToEvent`,
 * `./api.ts`), so a malformed results block fails the *query* — the error boundary gets
 * it, the cache is never primed with it, and no component ever renders a half-row.
 */
export function parseResults(input: unknown): EventResults | null {
  return resultsSchema.parse(input)
}
