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

  // `between` is the one operator whose value is not a scalar — it is a
  // `[min, max]` tuple behind two controls — and it survived the vocabulary
  // narrowing (ADR-0783) that took the enum and bool fields away. So it gets the
  // editor-side proof those branches used to crowd out: both bounds render, and
  // editing one keeps the other.
  describe('a between rule', () => {
    const betweenRule = () =>
      buildPredicate({ field: 'rating', op: 'between', value: [1200, 1500] })

    it('renders two bounds instead of a single value input', () => {
      predicateRowPage.render({ predicate: betweenRule() })

      expect(predicateRowPage.getLowerBoundInput()).toHaveValue(1200)
      expect(predicateRowPage.getUpperBoundInput()).toHaveValue(1500)
      expect(predicateRowPage.queryValueInput()).toBeNull()
    })

    it('writes each bound into its half of the tuple', () => {
      const onChange = vi.fn()
      predicateRowPage.render({ predicate: betweenRule(), onChange })

      fireEvent.change(predicateRowPage.getLowerBoundInput(), {
        target: { value: '1300' },
      })
      expect(onChange).toHaveBeenLastCalledWith(
        expect.objectContaining({ value: [1300, 1500] }),
      )

      fireEvent.change(predicateRowPage.getUpperBoundInput(), {
        target: { value: '1600' },
      })
      expect(onChange).toHaveBeenLastCalledWith(
        expect.objectContaining({ value: [1200, 1600] }),
      )
    })

    it('reads an emptied bound as null, not NaN', () => {
      const onChange = vi.fn()
      predicateRowPage.render({ predicate: betweenRule(), onChange })

      fireEvent.change(predicateRowPage.getUpperBoundInput(), {
        target: { value: '' },
      })
      expect(onChange).toHaveBeenLastCalledWith(
        expect.objectContaining({ value: [1200, null] }),
      )
    })
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
        'Rating is less than 1500',
      )
      // The number we hold is a Glicko-2 league rating, not a USATT one
      // (ADR-0783). Gating entry on the one while naming the other is exactly
      // the lie the ADR exists to remove.
      expect(predicateRowPage.getRow()).not.toHaveTextContent('USATT')
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
        'Rating is between 1200 and 1500',
      )
    })

    // An organizer can leave a rule's value empty; unset is an em-dash, not the
    // string "null" (the same contract `ReadOnlyValue` keeps).
    it('reads an unset value as an em-dash', () => {
      predicateRowPage.render({
        predicate: buildPredicate({ field: 'rating', op: '>=', value: null }),
        canEdit: false,
      })
      expect(predicateRowPage.getRow()).toHaveTextContent('Rating is at least —')
      expect(predicateRowPage.getRow()).not.toHaveTextContent('null')
    })
  })
})
