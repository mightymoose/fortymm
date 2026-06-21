import userEvent from '@testing-library/user-event'

import { ApiError } from '@/api/client'

import { newTournamentModalPage } from './new-tournament-modal.page'

describe('NewTournamentModal', () => {
  it('emits the draft with name and address, then closes on success', async () => {
    const onCreate = vi.fn()
    const onOpenChange = vi.fn()
    newTournamentModalPage.render({ onCreate, onOpenChange })

    await userEvent.type(newTournamentModalPage.getNameInput(), 'Spring Open')
    await userEvent.click(newTournamentModalPage.getCreateButton())

    expect(onCreate).toHaveBeenCalledTimes(1)
    expect(onCreate.mock.calls[0][0]).toMatchObject({
      name: 'Spring Open',
      status: 'draft',
    })
    // The modal owns closing — only after onCreate resolves.
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('blocks an empty name with an inline error and does not submit', async () => {
    const onCreate = vi.fn()
    newTournamentModalPage.render({ onCreate })

    await userEvent.click(newTournamentModalPage.getCreateButton())

    expect(
      await newTournamentModalPage.findError('Name is required.'),
    ).toBeVisible()
    expect(newTournamentModalPage.getNameInput()).toHaveAttribute(
      'aria-invalid',
      'true',
    )
    expect(onCreate).not.toHaveBeenCalled()
  })

  it('blocks a name longer than 255 characters client-side', async () => {
    const onCreate = vi.fn()
    newTournamentModalPage.render({ onCreate })

    const input = newTournamentModalPage.getNameInput()
    await userEvent.click(input)
    await userEvent.paste('A'.repeat(256))
    await userEvent.click(newTournamentModalPage.getCreateButton())

    expect(
      await newTournamentModalPage.findError(
        'Name must be 255 characters or fewer.',
      ),
    ).toBeVisible()
    expect(onCreate).not.toHaveBeenCalled()
  })

  it('surfaces a server rejection inline and keeps the dialog open', async () => {
    const onCreate = vi
      .fn()
      .mockRejectedValue(
        new ApiError(
          422,
          'String should have at most 255 characters',
          'create',
        ),
      )
    const onOpenChange = vi.fn()
    newTournamentModalPage.render({ onCreate, onOpenChange })

    await userEvent.type(newTournamentModalPage.getNameInput(), 'Spring Open')
    await userEvent.click(newTournamentModalPage.getCreateButton())

    expect(onCreate).toHaveBeenCalledTimes(1)
    expect(
      await newTournamentModalPage.findError(
        'String should have at most 255 characters',
      ),
    ).toBeVisible()
    // Failure must not close over the user's entry.
    expect(onOpenChange).not.toHaveBeenCalledWith(false)
  })

  it('closes via cancel', async () => {
    const onOpenChange = vi.fn()
    newTournamentModalPage.render({ onOpenChange })

    await userEvent.click(newTournamentModalPage.getCancelButton())
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })
})
