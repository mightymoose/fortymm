import { render, screen, type Container } from '@/test/utilities'

import {
  NewTournamentModal,
  type NewTournamentModalProps,
} from './new-tournament-modal'
import { buildNewTournamentModalProps } from './new-tournament-modal.factory'

const scoped = (container: Container) => ({
  getNameInput() {
    return container.getByLabelText(/Name/)
  },
  getCreateButton() {
    return container.getByRole('button', { name: /Create tournament/ })
  },
  getCancelButton() {
    return container.getByRole('button', { name: /Cancel/ })
  },
  queryDialog() {
    return container.queryByRole('dialog')
  },
  /** The inline validation/error text under a field (the `Field` hint), once it
   * appears — absent until a failed submit or an invalid edit. */
  findError(message: string | RegExp) {
    return container.findByText(message)
  },
  /** The dialog's refusal banner — what a server rejection the form cannot pin to a
   * single box lands in. Queried by test id rather than by its copy, so a spec can
   * assert what it does *not* say. */
  queryErrorBanner() {
    return container.queryByTestId('new-tournament-error')
  },
  findErrorBanner() {
    return container.findByTestId('new-tournament-error')
  },
})

/**
 * Test page-object for `NewTournamentModal`. The dialog portals to the body, so
 * accessors resolve against `screen` rather than a wrapper subtree. Inline
 * errors are async (the zod resolver runs on submit), so assert them with
 * `await page.findError(...)`.
 */
export const newTournamentModalPage = {
  render(overrides: Partial<NewTournamentModalProps> = {}) {
    render(<NewTournamentModal {...buildNewTournamentModalProps(overrides)} />)
  },

  within(container: Container = screen) {
    return scoped(container)
  },

  ...scoped(screen),
}
