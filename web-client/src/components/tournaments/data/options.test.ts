import type { components } from '@/api/schema'

import { eventSchema } from '../tournament-detail-page/event-form'
import {
  DRAW_TYPE_OPTIONS,
  PRED_FIELDS,
  PRED_OPS_BY_TYPE,
  parsePredicateOp,
  type PredicateOp,
} from './options'
import type { DrawType, Predicate } from './types'

/** The seven operators, written down once. They are pinned at BOTH levels off
 * this one list: what the builder *renders* (runtime, below) and what a
 * `Predicate` may *hold* (compile time, further below). */
const SEVEN_OPS = ['<', '<=', '>', '>=', '=', '!=', 'between'] as const

/** The eligibility vocabulary is a *contract with the API*, not a styling
 * choice: `Predicate.field` is `Literal["rating"]` server-side and a rule naming
 * anything else is a 422 (ADR-0783). The builder composes its field picker
 * straight out of `PRED_FIELDS`, so this list IS what a director can author —
 * pin it, or the next person to re-add "Age" ships a payload the server refuses.
 */
describe('the eligibility predicate vocabulary', () => {
  it('offers exactly one field: rating', () => {
    expect(Object.keys(PRED_FIELDS)).toEqual(['rating'])
  })

  // We hold a Glicko-2 league rating. Naming it after a ladder we do not hold is
  // the lie ADR-0783 exists to remove.
  it('names it "Rating", not "USATT rating"', () => {
    expect(PRED_FIELDS.rating.label).toBe('Rating')
  })

  // The fields went; their operators went with them. What must NOT go is the
  // numeric set — narrowing the vocabulary was never meant to cost a rating rule
  // its operators, and `between` (the two-bound one) is the fragile one.
  it('keeps every numeric operator, including between', () => {
    expect(PRED_OPS_BY_TYPE[PRED_FIELDS.rating.type].map((o) => o.value)).toEqual([
      ...SEVEN_OPS,
    ])
  })
})

/** These are compile-time assertions, enforced by `tsc -b` (`npm run build`) —
 * `vitest` alone does not typecheck, so a red here is a **build** failure, not a
 * test failure. That is the whole point: an operator the API does not accept must
 * be impossible to *write*, not merely to observe.
 *
 * Verified by regression, not by compiling green — widening `Predicate['op']`
 * back to `string`, or putting `string | boolean` back into `PredicateValue`,
 * makes `npm run build` fail on this file. */
describe('the predicate type (a contract with the API, not a convention)', () => {
  it('admits exactly the seven operators — never a bare string', () => {
    expectTypeOf<PredicateOp>().toEqualTypeOf<(typeof SEVEN_OPS)[number]>()
    // ...and the domain type is that type, so the table cannot drift from it.
    expectTypeOf<Predicate['op']>().toEqualTypeOf<PredicateOp>()
    expect(SEVEN_OPS).toHaveLength(7)
  })

  it('admits only a number, a [min, max] pair, or null as a value', () => {
    // `string | boolean` left with the gender/club fields (ADR-0783) and with
    // the API's own narrowing of `Predicate.value` — they must not creep back.
    expectTypeOf<Predicate['value']>().toEqualTypeOf<
      number | [number | null, number | null] | null
    >()
  })

  // The compile-time half only holds if nothing casts its way past it. The
  // builder's operator `<select>` hands back a raw `string`, and this is the
  // parse that turns it into a `PredicateOp` — the runtime edge of the same
  // contract.
  it('parses every operator the builder offers back out of the select', () => {
    for (const op of SEVEN_OPS) {
      expect(parsePredicateOp('number', op)).toBe(op)
    }
  })

  it('refuses an operator the table never offered', () => {
    expect(parsePredicateOp('number', 'is')).toBeNull()
  })

  it('makes an operator the server would 422 a compile error', () => {
    const rule = {
      id: 'pr-1',
      field: 'rating',
      // @ts-expect-error 'is' is not one of the seven operators the API accepts.
      op: 'is',
      value: 1500,
    } satisfies Predicate
    expect(rule.op).toBe('is')
  })
})

/** The DRAW TYPE vocabulary — the same contract, one layer up (ADR 20260726 "a draw
 * type is a seeded row, and the enum holds only what runs").
 *
 * `DrawType` used to name five types while the server could plan two, so a director
 * could pick "Swiss" from the picker, create the event, enter a whole field, and only
 * discover at the moment they cut the draw that it was never possible. The API's enum
 * now holds exactly the two that run, and the three that did not are a **422 at the
 * request boundary**.
 *
 * The client keeps three hand-written copies of that vocabulary — the domain union, the
 * form's `z.enum`, and the picker's option list — and nothing but this file makes them
 * agree with the generated schema. All three are pinned here, two at compile time
 * (`tsc -b`, i.e. `npm run build` — vitest does not typecheck) and one at runtime. */
describe('the draw-type vocabulary (a contract with the API, not a menu)', () => {
  /** The generated enum, straight off `schema.d.ts` — never re-typed here, or the pin
   * would be two lists agreeing with each other rather than with the server. */
  type WireDrawType = components['schemas']['DrawType']

  it('is EXACTLY the API’s enum — no client-only member can exist', () => {
    expectTypeOf<DrawType>().toEqualTypeOf<WireDrawType>()
  })

  it('is the same set the event form will accept', () => {
    type FormDrawType = ReturnType<typeof eventSchema.parse>['drawType']
    expectTypeOf<FormDrawType>().toEqualTypeOf<WireDrawType>()
  })

  // The runtime half: the type only constrains what an option *may* say, not which
  // options are actually offered. A stale entry left in this list is a menu item whose
  // click ends in a 422 — which is the exact failure the ADR removed.
  it('offers exactly the two draw types the server can plan, each with a label', () => {
    expect(DRAW_TYPE_OPTIONS.map((o) => o.value)).toEqual([
      'single-elim',
      'round-robin',
    ])
    for (const option of DRAW_TYPE_OPTIONS) {
      expect(option.label.trim()).not.toBe('')
    }
  })

  it('makes a draw type the server would 422 a compile error', () => {
    // @ts-expect-error 'swiss' left the API's enum — it is not a draw type any more.
    const drawType: DrawType = 'swiss'
    expect(drawType).toBe('swiss')
  })
})
