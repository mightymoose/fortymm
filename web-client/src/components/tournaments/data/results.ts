// The **results** boundary (ADR-0788, widened by ADR-0785): where an event's results stop
// being bytes off the wire and become a typed domain value.
//
// An event's results are a **discriminated union tagged by shape** — `standings` (a table
// per group) for round-robin, `finishes` (a placement list) for single-elimination,
// `standings_then_finishes` (one of each, ADR 20260727) for round-robin-then-knockout, and
// `swiss_standings` (one table over the whole field, no groups) for swiss —
// plus whether the whole event is decided and its champion, all derived *live* on the server
// from the fixtures' currently-completed matches (never a snapshot). This is the runtime
// parse that guards them, the twin of `./fixtures` for the draw. The parse switches on
// `kind`, so an **unknown shape fails HERE**, at the boundary, before it can leak inward.
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
// no draw, or its draw type has no results strategy yet. An
// event whose payload simply *omitted* the field would be one we could not tell apart from
// one that means "no results", so the schema refuses the absent case and accepts only an
// explicit `null` or a real results object.

import { z } from 'zod'

import type {
  EventResults,
  FinishRow,
  GroupStandings,
  StandingRow,
  SwissStandingRow,
} from './types'

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
 * holds cannot drift apart.
 *
 * Extracted as a function rather than inlined in the transform below, because the **swiss**
 * row is this row plus one column and reuses it: one mapping, so a column added to the
 * shared shape reaches both tables at once and the two cannot fork. */
const toStandingRow = (r: z.output<typeof standingRowWireSchema>): StandingRow => ({
  entryId: r.entry_id,
  rank: r.rank,
  played: r.played,
  wins: r.wins,
  losses: r.losses,
  gamesWon: r.games_won,
  gamesLost: r.games_lost,
  gameDifference: r.game_difference,
})

const standingRowSchema = standingRowWireSchema.transform(toStandingRow)

/** The wire shape (`SwissStandingRowRead`): a group's row **plus `buchholz`** — the sum of
 * this entrant's opponents' win counts, and the tiebreak that sits above game difference in
 * swiss (ADR "swiss standings add Buchholz, and head-to-head is guarded on having met").
 *
 * `.extend()`ed from the shared row rather than re-declared, so the eight fields both
 * tables' rows carry are stated once. Eight is what the **wire** sends, not what either
 * table shows: `played` and `gamesLost` are parsed and carried inward, and neither is a
 * column. Required and an integer, exactly as the wire has it: a
 * missing `buchholz` is real server drift, and it fails HERE rather than rendering as an
 * empty cell in the one column that explains the order. `0` is a legitimate value — an
 * entrant every one of whose opponents has yet to win — so it is not a "missing" stand-in
 * and must never be coalesced from one. */
const swissStandingRowWireSchema = standingRowWireSchema.extend({
  buchholz: z.number().int(),
})

/** One wire swiss row → one domain `SwissStandingRow`. Annotated for the same reason, and
 * built on `toStandingRow` so the shared columns are mapped by the shared mapper. */
const swissStandingRowSchema = swissStandingRowWireSchema.transform(
  (r): SwissStandingRow => ({ ...toStandingRow(r), buchholz: r.buchholz }),
)

/** The wire shape (`GroupStandingsRead`): a group's rows **in the server's finishing order**
 * plus whether every one of its fixtures is decided. The order is untrusted like any other
 * data, but it is NOT re-sorted here (ADR-0788 — the order *is* the result); it is parsed
 * as given and carried inward unchanged. */
const groupStandingsWireSchema = z.object({
  group_id: z.string(),
  rows: z.array(standingRowSchema),
  complete: z.boolean(),
})

const groupStandingsSchema = groupStandingsWireSchema.transform(
  (p): GroupStandings => ({
    groupId: p.group_id,
    rows: p.rows,
    complete: p.complete,
  }),
)

/** The wire shape (`StandingsResultsRead`): the round-robin arm, tagged `kind: "standings"`
 * — the groups, whether the whole event is decided, and its champion (an **entry id**, or
 * `null`). */
const standingsResultsWireSchema = z.object({
  kind: z.literal('standings'),
  groups: z.array(groupStandingsSchema),
  complete: z.boolean(),
  /** `null` while any fixture is unplayed, and for a multi-group event, which has no single
   * champion without a knockout stage (a later slice). */
  champion: z.string().nullable(),
})

/** The wire shape (`FinishRowRead`), snake_case, every field required. `position` is 1-based
 * and shared by same-round losers; `eliminated_in_round` is the 1-based round the entrant
 * lost in, or `null` for the champion (never eliminated). */
const finishRowWireSchema = z.object({
  entry_id: z.string(),
  position: z.number().int(),
  eliminated_in_round: z.number().int().nullable(),
})

/** One wire finish → one domain `FinishRow`. Annotated `: FinishRow` on purpose — the same
 * discipline as the standings row: drop a field from either the interface or this schema and
 * this line is a compile error, so the runtime parser and the type the app holds cannot
 * drift. */
const finishRowSchema = finishRowWireSchema.transform(
  (r): FinishRow => ({
    entryId: r.entry_id,
    position: r.position,
    eliminatedInRound: r.eliminated_in_round,
  }),
)

/** The wire shape (`FinishesResultsRead`): the single-elimination arm, tagged
 * `kind: "finishes"` — the finishes **in the server's order** (position ascending, ties
 * sharing a position; NOT re-sorted here — the order *is* the result), whether the bracket
 * is decided, and its champion (an **entry id**, or `null` until the final is decided). */
const finishesResultsWireSchema = z.object({
  kind: z.literal('finishes'),
  finishes: z.array(finishRowSchema),
  complete: z.boolean(),
  champion: z.string().nullable(),
})

/** The wire shape (`StandingsThenFinishesResultsRead`): the round-robin-then-knockout arm,
 * tagged `kind: "standings_then_finishes"` — **one block per stage**, and each is the very
 * model its own arm sends: `groups` are the `GroupStandingsRead`s a round-robin reads out,
 * `finishes` the `FinishRowRead`s a single-elimination reads out. Reusing the two row
 * parsers here is the point: the two-stage shape cannot drift from the shapes it composes,
 * and a malformed row fails at the same boundary whichever arm carried it.
 *
 * `complete` is **both** stages decided; `champion` is the **bracket final's** winner (never
 * a group leader — the group stage only seeds), `null` until that final lands. A mid-flight
 * event is the ordinary case: complete groups, a `finishes` list holding only the entrants
 * the bracket has placed so far. */
const standingsThenFinishesResultsWireSchema = z.object({
  kind: z.literal('standings_then_finishes'),
  groups: z.array(groupStandingsSchema),
  finishes: z.array(finishRowSchema),
  complete: z.boolean(),
  champion: z.string().nullable(),
})

/** The wire shape (`SwissStandingsResultsRead`): the swiss arm, tagged
 * `kind: "swiss_standings"` — **one list of rows over the whole field**, whether every round
 * is decided, and the leader once it is.
 *
 * The rows are `swissStandingRowSchema` — the very parser a group's standings use, extended
 * by the one field swiss adds — so the two tables cannot drift on the eight they share and
 * a malformed row fails at the same boundary whichever arm carried it. The two structural
 * differences are both facts about the format: no group to group under (swiss ranks the whole
 * field in one table, ADR "swiss pre-cuts every round and pairs each one on advance") and
 * the `buchholz` figure that ordered each row. */
const swissStandingsResultsWireSchema = z.object({
  kind: z.literal('swiss_standings'),
  rows: z.array(swissStandingRowSchema),
  complete: z.boolean(),
  champion: z.string().nullable(),
})

/** The parsed wire union — the input to the transform below, named so the transform can
 * switch on it exhaustively. */
type EventResultsWire = z.output<
  | typeof standingsResultsWireSchema
  | typeof finishesResultsWireSchema
  | typeof standingsThenFinishesResultsWireSchema
  | typeof swissStandingsResultsWireSchema
>

/** Wire → domain, arm by arm. A `switch` with a `never` default rather than a chain of
 * ternaries: adding a fourth arm to the union above without a mapping here is a **compile
 * error**, which is the same guarantee `ResultsPanel`'s exhaustive switch gives the render
 * path. Nothing is re-ordered or recomputed — the order *is* the result. */
function toDomain(r: EventResultsWire): EventResults {
  switch (r.kind) {
    case 'standings':
      return {
        kind: 'standings',
        groups: r.groups,
        complete: r.complete,
        champion: r.champion,
      }
    case 'finishes':
      return {
        kind: 'finishes',
        finishes: r.finishes,
        complete: r.complete,
        champion: r.champion,
      }
    case 'standings_then_finishes':
      return {
        kind: 'standings_then_finishes',
        groups: r.groups,
        finishes: r.finishes,
        complete: r.complete,
        champion: r.champion,
      }
    case 'swiss_standings':
      return {
        kind: 'swiss_standings',
        rows: r.rows,
        complete: r.complete,
        champion: r.champion,
      }
    default: {
      const exhaustive: never = r
      return exhaustive
    }
  }
}

/** The results union, **discriminated on `kind`**: Zod picks the arm by the tag and rejects
 * any other shape (a missing/unknown `kind`, or a `finishes` block carrying `groups`) HERE,
 * at the boundary. The transform switches on the same tag to hand the app a domain value
 * that still carries `kind`, so every consumer narrows the union exhaustively.
 *
 * ⚠️ **Adding an arm must never make this permissive.** The union lists exactly the shapes
 * this client can render; a tag it has never heard of is real server drift, and it fails
 * here — loudly, in the queryFn — rather than reaching a component that would render half a
 * page. `results.test.ts` pins that with an unknown `kind`, deliberately one a hair away
 * from a known one. */
export const eventResultsSchema = z
  .discriminatedUnion('kind', [
    standingsResultsWireSchema,
    finishesResultsWireSchema,
    standingsThenFinishesResultsWireSchema,
    swissStandingsResultsWireSchema,
  ])
  .transform(toDomain)

/** An event's `results`, or `null`. **`.nullable()`, never `.optional()`** — the key must
 * be present, and a `null` is the designed "no results here" state, not a missing field
 * (an event with no draw, or a draw type with no results strategy yet). */
export const resultsSchema = eventResultsSchema.nullable()

/**
 * Parse an event's `results` off the wire, or throw.
 *
 * Takes `unknown`, deliberately: the value it is handed is typed
 * `(StandingsResultsRead | FinishesResultsRead) | null` by the generated schema, and that
 * union is exactly the claim this function exists to check at runtime. Accepting the typed
 * shape would let the compiler talk us out of the runtime guarantee.
 *
 * Throws a `ZodError` — including for an unknown `kind`. Called from the tournament queries'
 * `queryFn` (via `apiToEvent`, `./api.ts`), so a malformed results block fails the *query* —
 * the error boundary gets it, the cache is never primed with it, and no component ever
 * renders a half-row.
 */
export function parseResults(input: unknown): EventResults | null {
  return resultsSchema.parse(input)
}
