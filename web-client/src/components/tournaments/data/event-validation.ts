// What makes an event *saveable* — the field rules the editor's form is resolved
// against (#783 QA, round two; ADR-0935).
//
// The rule builder got a client-side guard and the name did not, so the two halves
// of the same form behaved differently: an empty rule was refused **in the form**,
// while an empty NAME went to the server, came back a 422, and was reported in a
// banner — in Pydantic's words. Same organizer, same click, two different stories,
// and only one of them told them where to look.
//
// So the schema mirrors the server's constraints for every field the server can
// refuse (`TournamentEventCreate` / `TournamentEventUpdate`,
// `api/app/schemas/tournament.py`) — which is the house rule for a form
// (web-client `CLAUDE.md`, `## Forms`), and the sibling `NewTournamentModal` already
// does exactly this for the *tournament's* name, down to the copy:
//
//   | field         | server                                | here                        |
//   | ------------- | ------------------------------------- | --------------------------- |
//   | `name`        | `min_length=1, max_length=255`        | required, ≤ 255             |
//   | `max_players` | `EventMaxPlayers | None`, `gt=0`,     | **optional** — blank is no  |
//   |               | `le=512`, `default=None`              | cap; when present, 1 … 512  |
//   | `entry_fee`   | `EventEntryFee`: `ge=0`, `le=999…99`, | required; 0 … 999,999.99,   |
//   |               | whole cents                           | in whole cents              |
//   | `qualifiers   | `QualifiersPerPool`: `ge=1`, `le=1000`,| required and 1 … 1,000 **for|
//   |  _per_pool`   | required on the `rr-then-ko` union arm, | `rr-then-ko` only** — the   |
//   |               | refused outright on the other three     | pair, not the field         |
//   | `rounds`      | `SwissRounds`: `ge=1`, `le=32`,       | required and 1 … 32 **for   |
//   |               | required on the `swiss` union arm,      | `swiss` only** — again the  |
//   |               | refused outright on the other three     | pair, not the field         |
//   | `predicates`  | (permissive — see below)              | `predicate-validation.ts`   |
//
// ⚠️ **BLANK IS NOT ZERO — AND THE TWO NUMBER FIELDS DISAGREE ABOUT WHICH IS WHICH**
// (ADR-0935). Both boxes used to be read through `Number(e.target.value)`, and
// **`Number('')` is `0`** — so clearing either one *authored a zero*, silently. For
// the player limit that is an event of nobody, which the server refuses (`gt=0`)
// with a 422 the form never caught; for the fee it is a free event, which is a real
// and legitimate answer the organizer never gave. One coercion, two different lies.
//
// The resolution is per field, and it is a difference in the DOMAIN, not in the
// input handling:
//
// - **A blank player limit is `null`, and `null` is a real state**: the event has no
//   cap. It is not an error, and it must never be coerced to `0` — a cap of zero is
//   nonsense (it admits nobody), and the DB's `CHECK (max_players > 0)` refuses it.
//   So the schema is `.nullable()`, and the `> 0` rule applies only to a cap that is
//   actually *there*.
// - **A blank entry fee is missing**, and missing is an error: a fee is required, and
//   `0` is a distinct, legitimate value (a free event). A blank box reaches this
//   schema as `NaN` — never as `0` — and `NaN` is what the "required" message hangs
//   on.
//
// ⚠️ **The column is a constraint too, and it is the one nobody mirrors** (#783 QA,
// round three). A player limit of `9999999999` satisfies `gt=0` — and then the INSERT
// hits an `Integer` column, PostgreSQL refuses the out-of-range value, and the API
// answers **500**. The organizer typed a number into a box and got a server crash.
// The same hole sits under the sibling field: `entry_fee` is `Numeric(8, 2)`, so a fee
// of 9,999,999 overflows it — and a fee of `45.005` is *silently rounded* to `45.01`,
// a price the organizer never typed. Both bounds are mirrored below, from the same
// numbers the server now states (`MAX_EVENT_PLAYERS` / `MAX_ENTRY_FEE`).
//
// `format`, `draw_type` and `match_settings.length_games` come off closed pickers,
// so a value the server would refuse cannot be authored. `slot` is three plain
// `str`s server-side (`Slot`): the API refuses nothing there, so neither does this —
// mirroring a constraint that does not exist would be inventing one.
//
// The *rules* keep their own module (`predicate-validation.ts`): they are the one
// part of the draft the server is deliberately MORE permissive about (it accepts a
// half-written rule; the client must not). `../tournament-detail-page/event-form.ts`
// composes all of it into the ONE `eventSchema` the editor's `zodResolver` runs — so
// a field is validated in exactly one place, whichever tab it lives on.

import { z } from 'zod'

import { poolEntryKey } from './pool-entries'
import type { PoolEntry } from './types'

/** `tournament_events.name` is `VARCHAR(255)`, `NOT NULL` — the same column
 * constraint `NewTournamentModal` mirrors for the tournament's own name, and the
 * same copy, because it is the same field to the person typing it. */
export const NAME_MAX = 255

/** The server's `EventMaxPlayers = Field(gt=0, …)`, and the DB's
 * `CHECK (max_players > 0)`. A tighter client-side floor would be a rule the API does
 * not have, and a save it refused would be a refusal nothing on the server would ever
 * have made. */
export const PLAYERS_MIN = 1

/** The ceiling on an event's player limit — **the number the form has always shown**
 * (`<Input type="number" max={512}>` on the Basics tab), and the number the server now
 * states as `MAX_EVENT_PLAYERS`. An `<input max>` is a hint to a spinner and to nothing
 * else: it does not stop a typed or pasted value, and `9999999999` went straight through
 * it to the server, which 500'd on the `Integer` column.
 *
 * 512 is a bound with a reason: it is a 512-player draw — nine rounds of single
 * elimination, more entrants than the largest table-tennis open in the country, and
 * comfortably inside the column. It is not the column's own limit (2,147,483,647),
 * because a number that only a database could love is not a *limit* — it is the absence
 * of one. Both layers name the same number on purpose. */
export const PLAYERS_MAX = 512

/** The ceiling on an entry fee: `entry_fee` is `Numeric(8, 2)` — six digits before the
 * point, two after — so this is the largest fee the column can hold, and one cent more
 * is the same 500 the player limit was (the server's `MAX_ENTRY_FEE`). */
export const ENTRY_FEE_MAX = 999_999.99

/** A fee is a price, and a price is in whole cents. The column is `Numeric(8, 2)`, and
 * Postgres does **not** refuse a third decimal — it silently *rounds* it, so `45.005` is
 * stored, read back and charged as `45.01`: a number the organizer never typed, with
 * nothing anywhere reporting the change. The server answers that with a 422
 * (`_fits_the_fee_column`); the form says it under the field, which is where they can
 * fix it. */
export const FEE_DECIMALS = 2

/** The event's name: present, and short enough for the column. */
export const nameSchema = z
  .string()
  .trim()
  .min(1, { error: 'Name is required.' })
  .max(NAME_MAX, { error: `Name must be ${NAME_MAX} characters or fewer.` })

/**
 * A **pool's** name: present. The same floor the server now states
 * (`Pool.name: str = Field(min_length=1)`, `api/app/schemas/tournament.py`), and the
 * same words as the event's own name — because to the organizer clearing a box it is
 * the same news, and a second wording for one fact is a second thing to drift.
 *
 * The pools editor *mints* a pool's default name ("Pool A"), so the happy
 * path could never author a blank one — but the name **box is live**, and an emptied
 * box was a save the form allowed and the server refused, with Pydantic's own prose
 * ("String should have at least 1 character") arriving in the editor's banner. That is
 * the hole `nameSchema` closed for the event a release ago, still open one tab over:
 * the whole point of the house rule (web-client `CLAUDE.md`, `## Forms`) is that a rule
 * the client can express is a rule met **under the field**, not in a 422.
 *
 * ⚠️ **No ceiling**, deliberately: `Pool.name` has `min_length=1` and no `max_length`
 * (unlike the event's `VARCHAR(255)` — a pool lives in JSONB, which has no column to
 * overflow). Mirroring a bound the API does not have would be inventing one, and a save
 * refused here is a save nothing on the server would ever have refused.
 *
 * A pool's **id** is not mirrored at all, and since ADR 20260801 there is nothing left
 * to mirror: the id is the SERVER's uuid, a new pool is sent with none, and this form
 * cannot author one (`PoolEntry`, `./types`). Even when the client did mint them, an
 * error about an id was one no organizer could act on or even *see* — there is no box —
 * and an unfixable red is worse than the impossible 422 it guards. The same goes for a
 * table's id.
 */
export const poolNameSchema = z
  .string()
  .trim()
  .min(1, { error: 'Name is required.' })

/**
 * What is wrong with each pool's **name**, keyed by `poolEntryKey` — `poolNameSchema`
 * read a second way, for the second reader.
 *
 * Keyed off the ENTRY rather than off an id, because half the pools in a live edit have
 * no id: one the director added a moment ago is waiting for the server to mint it
 * (ADR 20260801), and it still has a name box that can still be emptied. `poolEntryKey`
 * is the same key the cards are keyed on, so the red lands under the box it is about
 * whichever arm the entry is.
 *
 * The resolver's verdict on the array (`eventSchema`) is what refuses the *save*; this
 * is what puts the red under the *box*, and the two are the same rule and the same
 * sentence because the message comes off the schema itself, never re-typed beside it.
 * (`eligibilityIssues` is the same shape for the same reason: one rule, two readers of
 * it — never two rules.)
 *
 * A second reader is needed at all because RHF's `useFieldArray.update()` — how a pool
 * card writes an edit back — deliberately does **not** re-run the resolver (it sets no
 * `_actioned` flag, unlike append/remove: `useFieldArray`, RHF 7.81). So the resolver's
 * `errors.pools` is the verdict of the last *submit* and would sit there, in red, under
 * a name the organizer has already fixed. Computed from live form values instead, it
 * stops complaining the moment they type — which is what the event's own name box does
 * one tab over, and the organizer cannot be expected to know which of the two is backed
 * by which mechanism.
 */
export function poolNameIssues(
  pools: readonly PoolEntry[],
): Record<string, string> {
  const issues: Record<string, string> = {}
  for (const pool of pools) {
    const result = poolNameSchema.safeParse(pool.name)
    if (!result.success) {
      issues[poolEntryKey(pool)] = result.error.issues[0].message
    }
  }
  return issues
}

/**
 * The event's player limit — **nullable, because `null` means "no cap"** (ADR-0935).
 *
 * `.nullable()` is the whole design: a blank box is not an error and not a zero, it is
 * an *uncapped event*. Every other rule here applies only to a cap that is really
 * there, and the floor's message says the alternative out loud ("…or blank for no cap")
 * — because the organizer who typed `0` is one keystroke away from the answer they
 * actually wanted, and a bare "must be at least 1" would send them hunting for a number
 * instead.
 */
export const maxPlayersSchema = z
  .number()
  .int({ error: 'The player limit must be a whole number.' })
  .min(PLAYERS_MIN, {
    error: `The player limit must be at least ${PLAYERS_MIN}, or blank for no cap.`,
  })
  // Phrased like the name's ceiling ("Name must be 255 characters or fewer."), because
  // it is the same kind of news: a bound, stated, in the words of the thing bounded.
  .max(PLAYERS_MAX, { error: `The player limit must be ${PLAYERS_MAX} or fewer.` })
  .nullable()

/**
 * The event's entry fee — **required**, and `0` is a real answer (a free event).
 *
 * The empty box arrives as `NaN`, never as `0`: `BasicsSection` maps `''` to `NaN`
 * precisely so that "they left it blank" and "they typed zero" stay two different facts
 * all the way to here. `NaN` is therefore what the *required* message hangs on, and it
 * is asked FIRST — every comparison below silently passes it (`NaN < 0` is `false`, and
 * so is `NaN > MAX`), and leaning on `z.number()` to reject it does not work reliably
 * either: the same `z.number()` accepts `NaN` under the ESM build the app runs and
 * rejects it under the CJS one (measured, Zod 4.4.3). A validator whose verdict depends
 * on the module system is not a validator, so the check is explicit.
 */
export const entryFeeSchema = z
  .union([z.nan(), z.number()])
  .superRefine((value, ctx) => {
    if (Number.isNaN(value)) {
      ctx.addIssue({ code: 'custom', message: 'Entry fee is required.' })
      return
    }
    if (value < 0) {
      ctx.addIssue({ code: 'custom', message: 'The entry fee cannot be negative.' })
      return
    }
    if (value > ENTRY_FEE_MAX) {
      ctx.addIssue({
        code: 'custom',
        message: `The entry fee must be ${ENTRY_FEE_MAX.toLocaleString('en-US')} or less.`,
      })
      return
    }
    // Read through the number's own shortest round-trip repr, exactly as the server does
    // (`Decimal(str(value))`), so what is judged is the number the organizer wrote:
    // `45.10` is two places, not the binary tail of 10.1.
    const decimals = String(value).split('.')[1]?.length ?? 0
    if (decimals > FEE_DECIMALS) {
      ctx.addIssue({
        code: 'custom',
        message: `An entry fee is in whole cents — at most ${FEE_DECIMALS} decimal places.`,
      })
    }
  })

/** The floor on **K** — the server's `QualifiersPerPool = Annotated[int, Field(ge=1)]`,
 * stated once there and mirrored once here. Zero advances nobody into the knockout
 * stage, and a negative count is not a count. */
export const QUALIFIERS_PER_POOL_MIN = 1

/** The ceiling on **K** — the server's `QualifiersPerPool = Annotated[int, Field(le=1000)]`,
 * the same number, stated in both layers on purpose.
 *
 * ⚠️ **This is the player limit's bug, one field over** (#1231 QA). `qualifiers_per_pool`
 * is an `Integer` column, so `2147483648` satisfied every rule either layer stated, hit
 * Postgres, and came back a **500** — reported to the director as "Something went wrong on
 * our end. Nothing you did caused it", which was false: they typed a number into a box.
 * `999999999` was worse, because it *worked*: it saved an event whose knockout stage could
 * never be cut.
 *
 * 1,000 is a bound with a reason, the way 512 is for the player limit: a pool of more than
 * a thousand finishers is not a pool, and the column's own 2,147,483,647 is not a *limit*,
 * it is the absence of one.
 *
 * It is **not** the same kind of bound as the server's two entrant-dependent ones
 * (`P × K >= 2` and `K <= ⌊N/P⌋`). Those move with the entrant count and are refused at the
 * *cut*, not at the write — a configuration that was legal when it was written must not
 * become unwritable when a player withdraws — so they are deliberately NOT mirrored here.
 * The cut's own refusal says which number to change, in the server's words
 * (`drawRefusalNotice`, `data/draw`). This one is fixed, known at write time, and refused
 * by the API at the request boundary, so the form states it too. */
export const QUALIFIERS_PER_POOL_MAX = 1000

/**
 * **K** — how many of each pool's finishers advance into an `rr-then-ko` draw's knockout
 * stage (ADR 20260727).
 *
 * NOT `.nullable()`, unlike the player limit, and the difference is the point: a blank
 * player limit is a real state (an uncapped event), while a blank qualifier count on a
 * two-stage event is **missing**. The server's `rr-then-ko` arm requires the field with
 * no default precisely because there is no defensible number to assume — "2" is a
 * convention, not a fact about the event — so `null` here is the *required* error and
 * not a value to coalesce. A `null` reaching the wire would be a 422; a `1` invented
 * here would be a bracket the director never asked for, which is worse, because it looks
 * like it worked.
 *
 * It is applied **only when the draw type is `rr-then-ko`** — see `eventSchema`
 * (`../tournament-detail-page/event-form`), which runs this parser from the object-level
 * refinement rather than inlining it as a field rule. The bound belongs to the
 * `(draw_type, K)` pair, exactly as it does on the server's tagged union, and a field
 * rule that fired regardless would put a red under a control that is not on screen: for
 * a round-robin event the box is not rendered at all (the draw type has no knockout
 * stage), so its error would be a save refused for a reason nobody can see or fix.
 */
export const qualifiersPerPoolSchema = z
  .number({ error: 'Say how many players advance from each pool.' })
  .int({ error: 'Qualifiers per pool must be a whole number.' })
  .min(QUALIFIERS_PER_POOL_MIN, {
    error: `At least ${QUALIFIERS_PER_POOL_MIN} player must advance from each pool.`,
  })
  // The floor's sentence, turned over — one bound, two directions, one voice. Stated as
  // a number the director can act on ("at most 1,000"), not as "invalid": the value they
  // typed is the only thing they can change.
  .max(QUALIFIERS_PER_POOL_MAX, {
    error: `At most ${QUALIFIERS_PER_POOL_MAX.toLocaleString('en-US')} players can advance from each pool.`,
  })

/** The floor on **R** — the server's `SwissRounds = Annotated[int, Field(ge=1, …)]`,
 * stated once there and mirrored once here. A swiss of zero rounds plays nothing, and a
 * negative count is not a count. */
export const SWISS_ROUNDS_MIN = 1

/** The ceiling on **R** — the server's `MAX_SWISS_ROUNDS`, the same number, stated in both
 * layers on purpose.
 *
 * The same kind of bound as `QUALIFIERS_PER_POOL_MAX`, and for the same reason: an
 * `Integer` column behind an unbounded box is a **500** reported to the director as
 * "something went wrong on our end", which is false — they typed a number. 32 is a bound
 * with a reason: the largest field this API will hold (512) is conventionally paired out in
 * nine rounds (`ceil(log2 n)`), so 32 is far above any event a table-tennis director will
 * run and far below the column's 2,147,483,647.
 *
 * It is **not** the same kind of bound as the server's entrant-dependent one
 * (`R <= n - 1 + n % 2`, the rounds a field can play without a rematch — `n - 1` for an even
 * field, and one more for an odd one, whose bye lets everybody play `n - 1` matches over `n`
 * rounds). That one moves with the field and is refused at the **cut** as a degenerate draw — a configuration that was legal when
 * it was written must not become unwritable when a player withdraws — so it is deliberately
 * NOT mirrored here. The cut's own refusal says which number to change, in the server's
 * words (`drawRefusalNotice`, `data/draw`). */
export const SWISS_ROUNDS_MAX = 32

/**
 * **R** — how many rounds a `swiss` event plays (ADR "swiss pre-cuts every round and pairs
 * each one on advance").
 *
 * NOT `.nullable()`, exactly like `qualifiersPerPoolSchema` and for the identical reason: a
 * blank round count on a swiss event is **missing**, not a state. The server's `swiss` arm
 * requires the field with no default precisely because there is no defensible number to
 * assume — `ceil(log2 n)` is the convention, and a derived default would move as entrants
 * arrived, changing the length of a day the director has already booked a venue for. So
 * `null` here is the *required* error and not a value to coalesce.
 *
 * It is applied **only when the draw type is `swiss`** — see `eventSchema`
 * (`../tournament-detail-page/event-form`), which runs this parser from the object-level
 * refinement rather than inlining it as a field rule. The bound belongs to the
 * `(draw_type, R)` pair, exactly as it does on the server's tagged union, and a field rule
 * that fired regardless would put a red under a control that is not on screen.
 */
export const swissRoundsSchema = z
  .number({ error: 'Say how many rounds this event plays.' })
  .int({ error: 'The number of rounds must be a whole number.' })
  .min(SWISS_ROUNDS_MIN, {
    // "Swiss", capitalised — the word the picker shows (the API's own seeded label,
    // `DRAW_TYPE_CATALOGUE`), never the `swiss` slug. A raw key in a sentence a director
    // reads is the leak `labelFor` exists to prevent, one surface over.
    error: `A Swiss event plays at least ${SWISS_ROUNDS_MIN} round.`,
  })
  // The floor's sentence, turned over — one bound, two directions, one voice. Stated as a
  // number the director can act on, not as "invalid".
  .max(SWISS_ROUNDS_MAX, {
    error: `A Swiss event plays at most ${SWISS_ROUNDS_MAX} rounds.`,
  })

/** The editor's five tabs, of which four can hold something invalid (Match settings
 * comes off closed pickers). A sum type rather than a `string`, so "which tab do I
 * open?" is answered from a closed set the editor's `TabsContent` values are checked
 * against.
 *
 * `draw-structure` is the conditional fifth (ADR 20260808) — present only on an
 * `rr-then-ko` event, and safe to name even when it is absent: the editor falls back to
 * Basics for a section no trigger matches. */
export type EventSection =
  | 'basics'
  | 'eligibility'
  | 'pools'
  | 'draw-structure'
