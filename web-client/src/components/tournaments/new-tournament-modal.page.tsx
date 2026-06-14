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
})

/**
 * Test page-object for `NewTournamentModal`. The dialog portals to the body, so
 * accessors resolve against `screen` rather than a wrapper subtree.
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
