import { interactiveControlsIn, interactiveElementsIn } from '@/test/read-only'
import { render, screen, type Container } from '@/test/utilities'

import { fieldPage } from '../../../field.page'
import { PoolCard, type PoolCardProps } from './pool-card'
import { buildPoolCardProps } from './pool-card.factory'

const scoped = (container: Container) => ({
  /** Reuse the `Field` row queries — the pool's window is three `Field` rows,
   * whose read-only values `getFieldValue(label)` reads back. */
  ...fieldPage.within(container),

  getCard() {
    return container.getByTestId('pool-card')
  },
  getNameInput() {
    return container.getByLabelText('Pool name')
  },
  queryNameInput() {
    return container.queryByLabelText('Pool name')
  },
  /** The red message under the name box — the resolver's verdict on this pool's name
   * (`poolNameSchema`). Absent until a save is actually attempted, and absent for a
   * viewer, who has no box to clear. */
  queryNameError() {
    return container.queryByTestId('pool-name-error')
  },
  getTableToggle(label: string) {
    return container.getByRole('button', { name: label, pressed: false })
  },
  getSelectedTableToggle(label: string) {
    return container.getByRole('button', { name: label, pressed: true })
  },
  getRemoveButton() {
    return container.getByRole('button', { name: 'Remove pool' })
  },
  /** Absent for a viewer: a mutating affordance is hidden, never disabled. */
  queryRemoveButton() {
    return container.queryByRole('button', { name: 'Remove pool' })
  },
  /** The pool's name, read back as text (the read-only counterpart of the name
   * box). */
  getName() {
    return container.getByTestId('pool-name')
  },
  /** The tables this pool reserves, read back as a list. */
  getReservedTables() {
    return container.getByTestId('pool-tables')
  },
  /** The timezone caption beside this pool's window (`pool-timezone-label`) — the
   * frame its wall-clock times are in (ADR 20260719), shown to editor and reader
   * alike. Not interactive, so it never touches the read-only guard sweep. */
  getTimezoneLabel() {
    return container.getByTestId('pool-timezone-label')
  },
  /** Every interactive control in the card, swept by role. Supplement only —
   * `getFormElements()` is the guarantee. */
  getInteractiveControls() {
    return interactiveControlsIn(container)
  },
  /** Every interactive element in the card, swept by DOM (`@/test/read-only`).
   * Empty is the point of the read-only view. */
  getFormElements() {
    return interactiveElementsIn(container.getByTestId('pool-card'))
  },
})

/** Test page-object for `PoolCard`. */
export const poolCardPage = {
  render(overrides: Partial<PoolCardProps> = {}) {
    render(<PoolCard {...buildPoolCardProps(overrides)} />)
  },

  within(container: Container = screen) {
    return scoped(container)
  },

  ...scoped(screen),
}
