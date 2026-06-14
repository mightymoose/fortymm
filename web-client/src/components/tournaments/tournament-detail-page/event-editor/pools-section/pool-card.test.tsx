import userEvent from '@testing-library/user-event'

import { buildPool } from '../../../data/seed.factory'
import { poolCardPage } from './pool-card.page'

describe('PoolCard', () => {
  it('marks the selected tables as pressed', () => {
    poolCardPage.render({ pool: buildPool({ tableIds: ['t1', 't2'] }) })
    expect(poolCardPage.getSelectedTableToggle('T1')).toBeInTheDocument()
    expect(poolCardPage.getTableToggle('T5')).toBeInTheDocument()
  })

  it('adds an unselected table on click', async () => {
    const onChange = vi.fn()
    poolCardPage.render({ pool: buildPool({ tableIds: ['t1'] }), onChange })
    await userEvent.click(poolCardPage.getTableToggle('T5'))
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ tableIds: ['t1', 't5'] }),
    )
  })

  it('removes the pool', async () => {
    const onRemove = vi.fn()
    poolCardPage.render({ onRemove })
    await userEvent.click(poolCardPage.getRemoveButton())
    expect(onRemove).toHaveBeenCalledTimes(1)
  })
})
