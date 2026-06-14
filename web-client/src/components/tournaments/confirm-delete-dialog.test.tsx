import userEvent from '@testing-library/user-event'

import { confirmDeleteDialogPage } from './confirm-delete-dialog.page'

describe('ConfirmDeleteDialog', () => {
  it('names the entity and kind being deleted', () => {
    confirmDeleteDialogPage.render({ kind: 'event', name: 'Open Singles' })
    const dialog = confirmDeleteDialogPage.queryDialog()
    expect(dialog).toHaveTextContent('Delete event?')
    expect(dialog).toHaveTextContent('Open Singles')
  })

  it('confirms the deletion', async () => {
    const onConfirm = vi.fn()
    confirmDeleteDialogPage.render({ onConfirm })
    await userEvent.click(confirmDeleteDialogPage.getConfirmButton())
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })
})
