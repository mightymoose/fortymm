import userEvent from '@testing-library/user-event'

import { buildTables } from '../data/seed.factory'
import { tablesTabPage } from './tables-tab.page'

describe('TablesTab', () => {
  it('adds a new table to the catalogue', async () => {
    const onChangeCatalogue = vi.fn()
    tablesTabPage.render({
      catalogue: buildTables(2),
      onChangeCatalogue,
    })

    await userEvent.type(tablesTabPage.getLabelInput(), 'T9')
    await userEvent.type(tablesTabPage.getCourtInput(), '9')
    await userEvent.click(tablesTabPage.getAddButton())

    expect(onChangeCatalogue).toHaveBeenCalledTimes(1)
    const next = onChangeCatalogue.mock.calls[0][0]
    expect(next).toHaveLength(3)
    expect(next[2]).toEqual(
      expect.objectContaining({ label: 'T9', court: '9' }),
    )
  })

  it('keeps the add button disabled until a label is entered', async () => {
    tablesTabPage.render({ catalogue: buildTables(2) })

    expect(tablesTabPage.getAddButton()).toBeDisabled()
    await userEvent.type(tablesTabPage.getLabelInput(), 'T9')
    expect(tablesTabPage.getAddButton()).toBeEnabled()
  })

  it('removes a table from the catalogue', async () => {
    const onChangeCatalogue = vi.fn()
    tablesTabPage.render({
      catalogue: buildTables(3),
      onChangeCatalogue,
    })

    await userEvent.click(tablesTabPage.getRemoveButton('T1'))

    expect(onChangeCatalogue).toHaveBeenCalledWith([
      expect.objectContaining({ id: 't2' }),
      expect.objectContaining({ id: 't3' }),
    ])
  })

  it('hides the add-table form and per-row removes for a non-creator', () => {
    tablesTabPage.render({ catalogue: buildTables(3), canEdit: false })

    expect(tablesTabPage.queryAddButton()).toBeNull()
    expect(tablesTabPage.queryRemoveButton('T1')).toBeNull()
    // The table list itself stays visible (read-only).
    expect(document.body).toHaveTextContent('T1')
  })
})
