import userEvent from '@testing-library/user-event'

import { UNBREAKABLE_TOURNAMENT_NAME } from '@/mocks/factories/tournaments/tournament.factory'

import { confirmDeleteDialogPage } from './confirm-delete-dialog.page'

describe('ConfirmDeleteDialog', () => {
  it('names the entity and kind being deleted', () => {
    confirmDeleteDialogPage.render({ kind: 'event', name: 'Open Singles' })
    const dialog = confirmDeleteDialogPage.queryDialog()
    expect(dialog).toHaveTextContent('Delete event?')
    expect(dialog).toHaveTextContent('Open Singles')
  })

  /**
   * #1417's criterion 4: the dialog **wraps** the name, it does not shorten it.
   *
   * The name is the fact a director checks before clicking Delete, so an ellipsis
   * would defeat the dialog's purpose. This is the half of the claim jsdom can make:
   * every one of the 255 characters is in the rendered output. The other half — that
   * the wrapped name keeps the buttons on screen — is a geometry claim, and it lives
   * in `e2e/tournaments/confirm-dialog-long-name.spec.ts` because jsdom performs no
   * layout and reports `0` for every measurement here.
   */
  it('renders a 255-character unbroken name in full', () => {
    confirmDeleteDialogPage.render({ name: UNBREAKABLE_TOURNAMENT_NAME })
    expect(UNBREAKABLE_TOURNAMENT_NAME).toHaveLength(255)
    expect(confirmDeleteDialogPage.queryDialog()).toHaveTextContent(
      UNBREAKABLE_TOURNAMENT_NAME,
    )
  })

  /** The prop type allows `undefined` — the list page passes `pendingDelete?.name`,
   * which is `undefined` on every render where nothing is pending. The dialog still
   * has to render. */
  it('renders with no name at all', () => {
    confirmDeleteDialogPage.render({ name: undefined })
    expect(confirmDeleteDialogPage.queryDialog()).toHaveTextContent('Delete tournament?')
  })

  it('confirms the deletion', async () => {
    const onConfirm = vi.fn()
    confirmDeleteDialogPage.render({ onConfirm })
    await userEvent.click(confirmDeleteDialogPage.getConfirmButton())
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })

  /**
   * #1417's criterion 6: every dismissal route the dialog has today survives the fix.
   *
   * Three routes, three cases rather than one, so a regression names the route that
   * broke rather than only that dismissal broke. Each asserts `onOpenChange(false)` —
   * the single channel all three report through — and that no delete fired, because a
   * dismiss that also deleted would be the worst possible regression here.
   */
  describe('dismissal', () => {
    it('dismisses on Cancel, and deletes nothing', async () => {
      const onOpenChange = vi.fn()
      const onConfirm = vi.fn()
      confirmDeleteDialogPage.render({ onOpenChange, onConfirm })
      await userEvent.click(confirmDeleteDialogPage.getCancelButton())
      expect(onOpenChange).toHaveBeenCalledWith(false)
      expect(onConfirm).not.toHaveBeenCalled()
    })

    it('dismisses on the Close icon, and deletes nothing', async () => {
      const onOpenChange = vi.fn()
      const onConfirm = vi.fn()
      confirmDeleteDialogPage.render({ onOpenChange, onConfirm })
      await userEvent.click(confirmDeleteDialogPage.getCloseButton())
      expect(onOpenChange).toHaveBeenCalledWith(false)
      expect(onConfirm).not.toHaveBeenCalled()
    })

    it('dismisses on Escape, and deletes nothing', async () => {
      const onOpenChange = vi.fn()
      const onConfirm = vi.fn()
      confirmDeleteDialogPage.render({ onOpenChange, onConfirm })
      await userEvent.keyboard('{Escape}')
      expect(onOpenChange).toHaveBeenCalledWith(false)
      expect(onConfirm).not.toHaveBeenCalled()
    })
  })
})
