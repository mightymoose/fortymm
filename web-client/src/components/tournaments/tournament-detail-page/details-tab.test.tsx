import userEvent from '@testing-library/user-event'

import { buildTournament } from '../data/seed.factory'
import { detailsTabPage } from './details-tab.page'

describe('DetailsTab', () => {
  it('reveals save only after an edit, then commits the draft', async () => {
    const onUpdate = vi.fn()
    detailsTabPage.render({
      tournament: buildTournament({ name: 'Bay Area Open 2026' }),
      onUpdate,
    })
    expect(detailsTabPage.querySaveButton()).toBeNull()

    await userEvent.type(detailsTabPage.getNameInput(), '!')
    const save = detailsTabPage.querySaveButton()
    expect(save).toBeInTheDocument()

    await userEvent.click(save!)
    expect(onUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Bay Area Open 2026!' }),
    )
  })

  it('disables the fields and hides save for a non-creator', () => {
    detailsTabPage.render({
      tournament: buildTournament({ name: 'Bay Area Open 2026' }),
      canEdit: false,
    })
    expect(detailsTabPage.getNameInput()).toBeDisabled()
    expect(detailsTabPage.querySaveButton()).toBeNull()
  })
})
