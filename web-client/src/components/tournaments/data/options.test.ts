import {
  PRED_FIELDS,
  PRED_OPS_BY_TYPE,
  STATUS_FILTER_OPTIONS,
  STATUS_TAB_LABEL,
  TOURNAMENT_STATUS_KEYS,
  parsePredicateOp,
  parseStatusFilter,
  type PredicateOp,
  type StatusFilter,
} from './options'
import type { Predicate, TournamentStatus } from './types'

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

/** The tournaments list's filter tabs. This list used to re-type the status values by
 * hand and it dropped `live`, so a tournament an owner had started was reachable only
 * under "All" (#970). It is now derived from a `Record<TournamentStatus, string>`, and
 * these pin both halves of that: the runtime strip, and the type that stops
 * `Object.keys`' `string[]` from widening the tab values back to `string`. */
describe('the tournament status filter tabs', () => {
  it('offers All plus one tab per status, in tab order', () => {
    expect(STATUS_FILTER_OPTIONS.map((o) => o.value)).toEqual([
      'all',
      'draft',
      'published',
      'live',
      'archived',
    ])
    expect(STATUS_FILTER_OPTIONS.map((o) => o.label)).toEqual([
      'All',
      'Drafts',
      'Published',
      'Live',
      'Archived',
    ])
  })

  // Deliberately NOT a `STATUS_FILTER_OPTIONS` vs `TOURNAMENT_STATUS_KEYS` comparison.
  // Both sides are built from `STATUS_TAB_LABEL`, so dropping a key removes it from
  // both and such a test can never fail — it would read as coverage while pinning
  // nothing. The exhaustiveness guard is `tsc -b`: deleting the `live` key reds with
  // `TS2741: Property 'live' is missing … but required in type
  // Record<TournamentStatus, string>`, falsified on this branch. The runtime shadow is
  // the literal five-value, five-label list asserted above, which does red on a drop.

  // A tab must read as the status pill does for the status it names — `Live` on both.
  it('labels the live tab the way the status pill does', () => {
    expect(STATUS_TAB_LABEL.live).toBe('Live')
  })

  it('parses a raw tab value, falling back to all', () => {
    for (const status of TOURNAMENT_STATUS_KEYS) {
      expect(parseStatusFilter(status)).toBe(status)
    }
    expect(parseStatusFilter('all')).toBe('all')
    expect(parseStatusFilter('someoldvalue')).toBe('all')
  })

  // Annotating the array is what keeps this from collapsing to `string`, which would
  // let an unknown tab value typecheck as a filter.
  it('keeps the tab value union narrow', () => {
    expectTypeOf<StatusFilter>().toEqualTypeOf<'all' | TournamentStatus>()
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
