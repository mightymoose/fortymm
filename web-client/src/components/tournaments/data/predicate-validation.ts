// What makes an eligibility rule *a rule* — the client-side guard the builder was
// missing (#783 QA).
//
// The API deliberately still ACCEPTS a null value: a half-written rule saved
// mid-edit constrains nobody, and the server is not in the business of guessing
// what the organizer meant. So this is not a fight with the server — it is the
// thing that has to exist *because* the server is permissive: without it the
// builder happily saved `Rating < ?` and rendered it on the event card as though
// it were a real restriction, and a `between` with both bounds empty went out as a
// 422 whose answer the editor threw away along with everything else the organizer
// had typed.
//
// The vocabulary is one numeric field (`rating`, ADR-0783), so there is one value
// schema, and it says three things — the same three the entry rules have always
// implied and nothing enforced:
//
//   1. **A rule must have a value.** A scalar operator needs a number; `between`
//      needs BOTH bounds. A rule that constrains nobody is not a rule.
//   2. **`between` runs low → high.** `Rating in [1600–1200]` is satisfiable by no
//      player alive, and it saved without a murmur.
//   3. **A rating is a rating.** 0–3000, whole points — the range the simulator
//      prototype's own validator stated in exactly these words ("Rating must be
//      0–3000."), reused rather than re-invented a second way.

import { z } from 'zod'

import type { Predicate } from './types'

/** The bounds a rating can honestly take. Not invented here: the simulator
 * prototype (since removed; its boards live on in the schedule tab) validated a
 * player's rating against the same 0–3000, and two ranges for one number is one
 * range too many. `999999999` was accepted before this. */
export const RATING_MIN = 0
export const RATING_MAX = 3000

/** En dash, matching the copy the simulator prototype showed. */
const RANGE_MESSAGE = `Rating must be ${RATING_MIN}–${RATING_MAX}.`

/** The value of a rating rule, as Zod: present, whole, and in range. `null` — the
 * empty input — trips the type error, which is why its message is the *empty*
 * message ("Enter a rating.") rather than a message about numbers. */
const ratingValue = z
  .number({ error: 'Enter a rating.' })
  .int({ error: 'Rating must be a whole number.' })
  .min(RATING_MIN, { error: RANGE_MESSAGE })
  .max(RATING_MAX, { error: RANGE_MESSAGE })

/** The message shown at the wrong bound of an inverted `between`. Hung on the
 * *upper* bound because that is the one the organizer typed last, and because a
 * message on both would say the same thing twice. */
export const BOUNDS_ORDER_MESSAGE =
  'The upper bound must be at least the lower bound.'

/**
 * What is wrong with one rule, keyed by the control that holds it — so the message
 * lands under the input the organizer has to fix, which is the house convention for
 * a field error (web-client `CLAUDE.md`, `## Forms`) and the only placement that
 * survives a rule list several rows long.
 *
 * A rule with nothing wrong has no entry at all (`null`), not an object of
 * `undefined`s: "is this rule valid?" is then a question about the *presence* of a
 * value, which cannot be got subtly wrong at a call site.
 */
export interface PredicateIssues {
  /** A scalar operator's single value (`<`, `>=`, `=`, …). */
  value?: string
  /** `between`'s lower bound. */
  lower?: string
  /** `between`'s upper bound — and where the inverted-bounds message lands. */
  upper?: string
}

function messageFor(value: number | null): string | undefined {
  const result = ratingValue.safeParse(value)
  return result.success ? undefined : result.error.issues[0].message
}

/**
 * Everything wrong with one rule, or `null` when it is a rule the server can
 * evaluate and a player can satisfy.
 *
 * The two value SHAPES are read exactly as the editor's controls render them
 * (`PredicateRow`): `between` is a `[lo, hi]` tuple behind two inputs, every other
 * operator is a scalar behind one. A value in the *other* shape — the tuple left
 * behind by switching `between` away, the scalar left behind by switching it on —
 * reads as **empty**, which is what its control is showing: the organizer is looking
 * at a blank box, and telling them "enter a rating" is the truth.
 */
export function predicateIssues(predicate: Predicate): PredicateIssues | null {
  const { op, value } = predicate

  if (op === 'between') {
    const [lower, upper] = Array.isArray(value) ? value : [null, null]
    const issues: PredicateIssues = {}

    const lowerMessage = messageFor(lower)
    const upperMessage = messageFor(upper)
    if (lowerMessage) issues.lower = lowerMessage
    if (upperMessage) issues.upper = upperMessage

    // Only once both bounds are real numbers is their ORDER a question. Asking it
    // of a half-filled rule would put a second, confusing message under a box that
    // is simply empty.
    if (
      typeof lower === 'number' &&
      typeof upper === 'number' &&
      !lowerMessage &&
      !upperMessage &&
      lower > upper
    ) {
      issues.upper = BOUNDS_ORDER_MESSAGE
    }

    return Object.keys(issues).length > 0 ? issues : null
  }

  const message = messageFor(Array.isArray(value) ? null : value)
  return message ? { value: message } : null
}

/** Every rule of an event that is not yet a rule, addressed by predicate id — the
 * shape the editor hands down to the rows, and the shape whose *emptiness* is the
 * editor's "may I submit?". Keyed by id rather than by index because the row list
 * is edited (added to, removed from) while the errors are on screen. */
export function eligibilityIssues(
  predicates: Predicate[],
): Record<string, PredicateIssues> {
  const issues: Record<string, PredicateIssues> = {}
  for (const predicate of predicates) {
    const found = predicateIssues(predicate)
    if (found) issues[predicate.id] = found
  }
  return issues
}
