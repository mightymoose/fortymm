import { describe, expect, it } from 'vitest'

import {
  BOUNDS_ORDER_MESSAGE,
  eligibilityIssues,
  predicateIssues,
  RATING_MAX,
  RATING_MIN,
} from './predicate-validation'
import { buildPredicate } from './seed.factory'

/** Each of these four rules SAVED before this module existed (201), and each one
 * then rendered on the event card as though it restricted somebody. The middle two
 * restrict nobody; the last two can be satisfied by nobody. */
describe('predicateIssues', () => {
  describe('a rule must have a value', () => {
    it('refuses a scalar operator with no number', () => {
      // The one that shipped: it saved, and the card printed the chip `Rating < ?`
      // — a rule constraining nobody, displayed as if it were real.
      expect(predicateIssues(buildPredicate({ op: '<', value: null }))).toEqual({
        value: 'Enter a rating.',
      })
    })

    it.each(['<', '<=', '>', '>=', '=', '!='] as const)(
      'refuses the empty value on every scalar operator (%s)',
      (op) => {
        expect(predicateIssues(buildPredicate({ op, value: null }))).toEqual({
          value: 'Enter a rating.',
        })
      },
    )

    it('refuses a between with BOTH bounds empty', () => {
      // QA's data-loss case: this went to the server, earned a 422, and the editor
      // closed over the answer.
      expect(
        predicateIssues(buildPredicate({ op: 'between', value: [null, null] })),
      ).toEqual({ lower: 'Enter a rating.', upper: 'Enter a rating.' })
    })

    it('refuses a between with only ONE bound filled', () => {
      expect(
        predicateIssues(buildPredicate({ op: 'between', value: [1200, null] })),
      ).toEqual({ upper: 'Enter a rating.' })
      expect(
        predicateIssues(buildPredicate({ op: 'between', value: [null, 1500] })),
      ).toEqual({ lower: 'Enter a rating.' })
    })
  })

  describe('a between runs low to high', () => {
    it('refuses inverted bounds', () => {
      // `Rating in [1600–1200]` saved happily. No player can ever satisfy it.
      expect(
        predicateIssues(buildPredicate({ op: 'between', value: [1600, 1200] })),
      ).toEqual({ upper: BOUNDS_ORDER_MESSAGE })
    })

    it('allows the degenerate equal bounds', () => {
      // `between 1500 and 1500` is exactly one rating — narrow, but satisfiable,
      // and not the editor's business to forbid.
      expect(
        predicateIssues(buildPredicate({ op: 'between', value: [1500, 1500] })),
      ).toBeNull()
    })

    it('says nothing about ORDER while a bound is still empty', () => {
      // A second message under a box that is simply blank would be noise.
      expect(
        predicateIssues(buildPredicate({ op: 'between', value: [1600, null] })),
      ).toEqual({ upper: 'Enter a rating.' })
    })
  })

  describe('a rating is a rating', () => {
    it('refuses a rating past the top of the scale', () => {
      // `Rating < 999999999` saved.
      expect(
        predicateIssues(buildPredicate({ op: '<', value: 999_999_999 })),
      ).toEqual({ value: `Rating must be ${RATING_MIN}–${RATING_MAX}.` })
    })

    it('refuses a negative rating', () => {
      expect(predicateIssues(buildPredicate({ op: '>', value: -50 }))).toEqual({
        value: `Rating must be ${RATING_MIN}–${RATING_MAX}.`,
      })
    })

    it('refuses a fractional rating', () => {
      expect(predicateIssues(buildPredicate({ op: '<', value: 1500.5 }))).toEqual({
        value: 'Rating must be a whole number.',
      })
    })

    it.each([RATING_MIN, 1500, RATING_MAX])('allows %i', (value) => {
      expect(predicateIssues(buildPredicate({ op: '<', value }))).toBeNull()
    })

    it('bounds a between at both ends too', () => {
      expect(
        predicateIssues(buildPredicate({ op: 'between', value: [-1, 4000] })),
      ).toEqual({
        lower: `Rating must be ${RATING_MIN}–${RATING_MAX}.`,
        upper: `Rating must be ${RATING_MIN}–${RATING_MAX}.`,
      })
    })
  })

  // Switching the operator keeps the value it had (the row does not clear it), so a
  // scalar rule can be holding a leftover tuple and a `between` a leftover scalar.
  // Either way the CONTROL the organizer is looking at is empty, so "enter a rating"
  // is what the message has to say — anything else describes a value they cannot see.
  describe('a value left in the other shape by an operator switch', () => {
    it('reads a leftover tuple under a scalar operator as empty', () => {
      expect(
        predicateIssues(buildPredicate({ op: '<', value: [1200, 1500] })),
      ).toEqual({ value: 'Enter a rating.' })
    })

    it('reads a leftover scalar under between as two empty bounds', () => {
      expect(predicateIssues(buildPredicate({ op: 'between', value: 1500 }))).toEqual({
        lower: 'Enter a rating.',
        upper: 'Enter a rating.',
      })
    })
  })

  it('passes an ordinary, satisfiable rule', () => {
    expect(predicateIssues(buildPredicate({ op: '<', value: 1500 }))).toBeNull()
    expect(
      predicateIssues(buildPredicate({ op: 'between', value: [1200, 1500] })),
    ).toBeNull()
  })
})

describe('eligibilityIssues', () => {
  it('addresses each broken rule by its ID, not its index', () => {
    // Rows are added and removed while the messages are on screen; an index-keyed
    // map would slide the error onto the neighbouring rule.
    const issues = eligibilityIssues([
      buildPredicate({ id: 'pr-ok', op: '<', value: 1500 }),
      buildPredicate({ id: 'pr-empty', op: '>=', value: null }),
      buildPredicate({ id: 'pr-inverted', op: 'between', value: [1600, 1200] }),
    ])

    expect(issues).toEqual({
      'pr-empty': { value: 'Enter a rating.' },
      'pr-inverted': { upper: BOUNDS_ORDER_MESSAGE },
    })
    expect(issues['pr-ok']).toBeUndefined()
  })

  it('is empty for a valid rule set — and for no rules at all', () => {
    expect(eligibilityIssues([])).toEqual({})
    expect(eligibilityIssues([buildPredicate({ op: '<', value: 1500 })])).toEqual({})
  })
})
