import { render, screen, type Container } from '@/test/utilities'

import {
  ConfirmDeleteDialog,
  type ConfirmDeleteDialogProps,
} from './confirm-delete-dialog'
import { buildConfirmDeleteDialogProps } from './confirm-delete-dialog.factory'

const scoped = (container: Container) => ({
  queryDialog() {
    return container.queryByRole('dialog')
  },
  getConfirmButton() {
    return container.getByRole('button', { name: /^Delete$/ })
  },
  getCancelButton() {
    return container.getByRole('button', { name: /Cancel/ })
  },
  /** The header's icon-only dismiss. Its only accessible name is the `sr-only`
   * "Close" span `DialogContent` renders beside the `X`, so this is the only way to
   * address it — and #1417's Constraints require it keep working. */
  getCloseButton() {
    return container.getByRole('button', { name: /^Close$/ })
  },
})

/** Test page-object for `ConfirmDeleteDialog`. Portals to the body. */
export const confirmDeleteDialogPage = {
  render(overrides: Partial<ConfirmDeleteDialogProps> = {}) {
    render(<ConfirmDeleteDialog {...buildConfirmDeleteDialogProps(overrides)} />)
  },

  within(container: Container = screen) {
    return scoped(container)
  },

  ...scoped(screen),
}
