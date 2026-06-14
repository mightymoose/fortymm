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
})
