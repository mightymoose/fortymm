import userEvent from '@testing-library/user-event'

import { buildTables, buildTournament } from '../data/seed.factory'
import { tablesTabPage } from './tables-tab.page'

describe('TablesTab', () => {
  it('adds an available table to the tournament', async () => {
    const onUpdate = vi.fn()
    tablesTabPage.render({
      tournament: buildTournament({ tableIds: ['t1'] }),
      allTables: buildTables(3),
      onUpdate,
    })
    await userEvent.click(tablesTabPage.getAddButton('T3'))
    expect(onUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ tableIds: ['t1', 't3'] }),
    )
  })

  it('removes an assigned table', async () => {
    const onUpdate = vi.fn()
    tablesTabPage.render({
      tournament: buildTournament({ tableIds: ['t1', 't2'], events: [] }),
      allTables: buildTables(3),
      onUpdate,
    })
    await userEvent.click(tablesTabPage.getRemoveButton('T1'))
    expect(onUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ tableIds: ['t2'] }),
    )
  })
})
