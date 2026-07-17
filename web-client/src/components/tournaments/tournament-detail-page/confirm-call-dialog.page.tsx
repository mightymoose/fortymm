import { fireEvent, render, screen, type Container } from '@/test/utilities'

import {
  ConfirmCallDialog,
  type ConfirmCallDialogProps,
} from './confirm-call-dialog'
import { buildConfirmCallDialogProps } from './confirm-call-dialog.factory'

const scoped = (container: Container) => ({
  queryDialog() {
    return container.queryByTestId('confirm-call-dialog')
  },
  getDialog() {
    return container.getByTestId('confirm-call-dialog')
  },
  /** The consequence-stating confirm button (`Call the match` / `Move and
   * notify` / `Cancel the call` — never a bare "OK"). */
  getConfirmButton() {
    return container.getByTestId('confirm-call-confirm')
  },
  getCancelButton() {
    return container.getByTestId('confirm-call-cancel')
  },
  /** The visible notified-count marker — absent on a first call. */
  queryNotified() {
    return container.queryByTestId('confirm-call-notified')
  },
  confirm() {
    fireEvent.click(container.getByTestId('confirm-call-confirm'))
  },
  cancel() {
    fireEvent.click(container.getByTestId('confirm-call-cancel'))
  },
})

/** Test page-object for `ConfirmCallDialog`. Portals to the body. */
export const confirmCallDialogPage = {
  render(overrides: Partial<ConfirmCallDialogProps> = {}) {
    render(<ConfirmCallDialog {...buildConfirmCallDialogProps(overrides)} />)
  },

  within(container: Container = screen) {
    return scoped(container)
  },

  ...scoped(screen),
}
