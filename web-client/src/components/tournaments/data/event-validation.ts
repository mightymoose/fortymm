// What makes an event *saveable* — the whole draft, not just its rules (#783 QA,
// round two).
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
//   | field         | server                        | here                        |
//   | ------------- | ----------------------------- | --------------------------- |
//   | `name`        | `min_length=1, max_length=255`| required, ≤ 255             |
//   | `max_players` | `int, gt=0`                   | a whole number, at least 1  |
//   | `entry_fee`   | `float, ge=0`                 | a number, not negative      |
//   | `predicates`  | (permissive — see below)      | `predicate-validation.ts`   |
//
// The empty cases are not hypothetical, and the number ones are worse than they look:
// `maxPlayers`/`entryFee` are edited through `Number(e.target.value)`, and
// **`Number('')` is `0`** — so *clearing the player limit is authoring an event of
// zero players*, which the server refuses (`gt=0`) with a 422 the form never caught.
// (`0` in the fee box is the one place that coercion is harmless: a free event is a
// real answer, and `ge=0` takes it.)
//
// `format`, `draw_type` and `match_settings.length_games` come off closed pickers,
// so a value the server would refuse cannot be authored. `slot` is three plain
// `str`s server-side (`Slot`): the API refuses nothing there, so neither does this —
// mirroring a constraint that does not exist would be inventing one.
//
// The *rules* keep their own module (`predicate-validation.ts`): they are the one
// part of the draft the server is deliberately MORE permissive about (it accepts a
// half-written rule; the client must not).

import { z } from 'zod'

import { eligibilityIssues, type PredicateIssues } from './predicate-validation'
import type { TournamentEvent } from './types'

/** `tournament_events.name` is `VARCHAR(255)`, `NOT NULL` — the same column
 * constraint `NewTournamentModal` mirrors for the tournament's own name, and the
 * same copy, because it is the same field to the person typing it. */
export const NAME_MAX = 255

/** The server's `max_players: int = Field(gt=0)`. A tighter client-side floor (the
 * input's `min={2}`) would be a rule the API does not have, and a save it refused
 * would be a refusal nothing on the server would ever have made. */
const PLAYERS_MIN = 1

const nameSchema = z
  .string()
  .trim()
  .min(1, { error: 'Name is required.' })
  .max(NAME_MAX, { error: `Name must be ${NAME_MAX} characters or fewer.` })

/** A cleared number box leaves **`NaN`** on the draft (`Number('')`), and `NaN` is
 * not a number the way this form means it: it is *nothing*, which is exactly what
 * the box is showing. So it is normalised to `null` before the schema sees it, and
 * trips the *type* error — whose message is therefore the empty message ("Enter a
 * player limit."), not a message about integers or minimums. Same shape as
 * `ratingValue` in `predicate-validation.ts`, where the empty input is a literal
 * `null` already.
 *
 * Normalising here rather than leaning on `z.number()` to reject `NaN` is
 * deliberate: it does not, reliably — the same `z.number().min(0)` accepts `NaN`
 * under the ESM build the app runs and rejects it under the CJS one (measured, Zod
 * 4.4.3). A validator whose verdict depends on the module system is not a validator. */
const numberOrNothing = (value: number): number | null =>
  Number.isFinite(value) ? value : null

const maxPlayersSchema = z
  .number({ error: 'Enter a player limit.' })
  .int({ error: 'The player limit must be a whole number.' })
  .min(PLAYERS_MIN, { error: `The player limit must be at least ${PLAYERS_MIN}.` })

const entryFeeSchema = z
  .number({ error: 'Enter an entry fee (0 for a free event).' })
  .min(0, { error: 'The entry fee cannot be negative.' })

/** What is wrong on the **Basics** tab, keyed by the control that holds it — so the
 * message lands under the input the organizer has to fix (`CLAUDE.md`, `## Forms`),
 * exactly as `PredicateIssues` does for a rule row. A clean field has no entry. */
export interface BasicsIssues {
  name?: string
  maxPlayers?: string
  entryFee?: string
}

/** The editor's four tabs, of which two can hold something invalid. A sum type
 * rather than a `string`, so "which tab do I open?" is answered from a closed set
 * the editor's `TabsContent` values are checked against. */
export type EventSection = 'basics' | 'eligibility'

/** Everything wrong with a draft event, by the section that owns it. Both halves are
 * computed together and shown together: "may I save?" and "what does this field say
 * in red?" are one answer, computed once, which is what keeps a refusal from landing
 * on a tab the organizer cannot see. */
export interface EventIssues {
  basics: BasicsIssues
  /** Keyed by predicate id (`eligibilityIssues`). */
  rules: Record<string, PredicateIssues>
}

function messageFor<T>(schema: z.ZodType<T>, value: unknown): string | undefined {
  const result = schema.safeParse(value)
  return result.success ? undefined : result.error.issues[0].message
}

/** Every reason this draft cannot be sent. Empty (`isSaveable`) is the editor's
 * permission to fire the mutation. */
export function eventIssues(event: TournamentEvent): EventIssues {
  const basics: BasicsIssues = {}

  const name = messageFor(nameSchema, event.name)
  if (name) basics.name = name

  const maxPlayers = messageFor(maxPlayersSchema, numberOrNothing(event.maxPlayers))
  if (maxPlayers) basics.maxPlayers = maxPlayers

  const entryFee = messageFor(entryFeeSchema, numberOrNothing(event.entryFee))
  if (entryFee) basics.entryFee = entryFee

  return { basics, rules: eligibilityIssues(event.predicates) }
}

/** True when nothing is wrong — the draft may go to the server. */
export function isSaveable(issues: EventIssues): boolean {
  return firstInvalidSection(issues) === null
}

/** The first tab holding something invalid, in the order the tabs are laid out —
 * where a refused save must take the organizer. `null` when the draft is clean.
 *
 * Basics before Eligibility, deliberately: with both broken, the name is the field
 * they are most likely to have simply not filled in, and landing on the *later* tab
 * would leave the empty name behind them, unseen. */
export function firstInvalidSection(issues: EventIssues): EventSection | null {
  if (Object.keys(issues.basics).length > 0) return 'basics'
  if (Object.keys(issues.rules).length > 0) return 'eligibility'
  return null
}
