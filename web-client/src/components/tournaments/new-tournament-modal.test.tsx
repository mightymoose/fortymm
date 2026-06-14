import userEvent from '@testing-library/user-event'

import { newTournamentModalPage } from './new-tournament-modal.page'

describe('NewTournamentModal', () => {
  it('disables create until a name is entered', async () => {
    newTournamentModalPage.render()
    expect(newTournamentModalPage.getCreateButton()).toBeDisabled()

    await userEvent.type(newTournamentModalPage.getNameInput(), 'Spring Open')
    expect(newTournamentModalPage.getCreateButton()).toBeEnabled()
  })

  it('emits the draft with name and address on create', async () => {
    const onCreate = vi.fn()
    newTournamentModalPage.render({ onCreate })

    await userEvent.type(newTournamentModalPage.getNameInput(), 'Spring Open')
    await userEvent.click(newTournamentModalPage.getCreateButton())

    expect(onCreate).toHaveBeenCalledTimes(1)
    expect(onCreate.mock.calls[0][0]).toMatchObject({
      name: 'Spring Open',
      status: 'draft',
    })
  })

  it('closes via cancel', async () => {
    const onOpenChange = vi.fn()
    newTournamentModalPage.render({ onOpenChange })

    await userEvent.click(newTournamentModalPage.getCancelButton())
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })
})
