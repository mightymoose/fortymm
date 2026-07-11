import userEvent from '@testing-library/user-event'

import { fireEvent } from '@/test/utilities'

import { buildPredicate } from '../../../data/seed.factory'
import { predicateRowPage } from './predicate-row.page'

describe('PredicateRow', () => {
  it('parses a numeric rule value to a number', () => {
    const onChange = vi.fn()
    predicateRowPage.render({
      predicate: buildPredicate({ field: 'rating', op: '<', value: 1500 }),
      onChange,
    })

    // Controlled input whose prop never updates here, so assert one change.
    fireEvent.change(predicateRowPage.getValueInput(), {
      target: { value: '1800' },
    })
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ value: 1800 }))
  })

  it('renders no numeric value input for a boolean field', () => {
    predicateRowPage.render({
      predicate: buildPredicate({ field: 'club', op: 'true', value: true }),
    })
    expect(predicateRowPage.queryValueInput()).toBeNull()
    expect(predicateRowPage.getRow()).toHaveTextContent('a club member')
  })

  it('removes the rule', async () => {
    const onRemove = vi.fn()
    predicateRowPage.render({ onRemove })
    await userEvent.click(predicateRowPage.getRemoveButton())
    expect(onRemove).toHaveBeenCalledTimes(1)
  })

  describe('for a non-owner (read-only)', () => {
    // The guard test (ADR 0015, rule 6): a viewer gets a rendering of the data,
    // never a disabled editor. The DOM sweep, not a role sweep — the value
    // control here is a `type="number"` input, i.e. a `spinbutton`, which the
    // four canonical roles miss entirely.
    it('renders no interactive controls', () => {
      predicateRowPage.render({
        predicate: buildPredicate({ field: 'rating', op: '<', value: 1500 }),
        canEdit: false,
      })
      // The DOM sweep first: it is the load-bearing one, so it is the one whose
      // red is worth seeing.
      expect(predicateRowPage.getFormElements()).toHaveLength(0)
      expect(predicateRowPage.getInteractiveControls()).toHaveLength(0)
      expect(predicateRowPage.queryRemoveButton()).toBeNull()
    })

    // Rule 4: the row is `[field] [operator] [value]` — already a sentence
    // chopped into a grid — so read-only it renders as the sentence, composed
    // from the very labels the editor's three controls show.
    it('reads a numeric rule as a sentence', () => {
      predicateRowPage.render({
        predicate: buildPredicate({ field: 'rating', op: '<', value: 1500 }),
        canEdit: false,
      })
      expect(predicateRowPage.getRow()).toHaveTextContent(
        'USATT rating is less than 1500',
      )
    })

    // The two-element value array — the likeliest to render wrong.
    it('reads a between rule as one sentence with both bounds', () => {
      predicateRowPage.render({
        predicate: buildPredicate({
          field: 'rating',
          op: 'between',
          value: [1200, 1500],
        }),
        canEdit: false,
      })
      expect(predicateRowPage.getRow()).toHaveTextContent(
        'USATT rating is between 1200 and 1500',
      )
    })

    it('reads an enum rule with the option label, not the stored key', () => {
      predicateRowPage.render({
        predicate: buildPredicate({ field: 'gender', op: 'is', value: 'F' }),
        canEdit: false,
      })
      expect(predicateRowPage.getRow()).toHaveTextContent('Gender is Female')
      expect(predicateRowPage.getRow()).not.toHaveTextContent('F is')
    })

    // The bool row already renders prose ("a club member") in the editor; the
    // field is the operator's own object, so the sentence is the operator plus
    // that prose — never "Club member must be a club member".
    it('reads a boolean rule as prose', () => {
      predicateRowPage.render({
        predicate: buildPredicate({ field: 'club', op: 'true', value: true }),
        canEdit: false,
      })
      expect(predicateRowPage.getRow()).toHaveTextContent(
        'Must be a club member',
      )
    })

    it('reads a negated boolean rule as prose', () => {
      predicateRowPage.render({
        predicate: buildPredicate({ field: 'club', op: 'false', value: false }),
        canEdit: false,
      })
      expect(predicateRowPage.getRow()).toHaveTextContent(
        'Must not be a club member',
      )
    })

    // An organizer can leave a rule's value empty; unset is an em-dash, not the
    // string "null" (the same contract `ReadOnlyValue` keeps).
    it('reads an unset value as an em-dash', () => {
      predicateRowPage.render({
        predicate: buildPredicate({ field: 'age', op: '>=', value: null }),
        canEdit: false,
      })
      expect(predicateRowPage.getRow()).toHaveTextContent('Age is at least —')
      expect(predicateRowPage.getRow()).not.toHaveTextContent('null')
    })
  })
})
