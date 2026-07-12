import { interactiveControlsIn, interactiveElementsIn } from '@/test/read-only'
import { render, screen, type Container } from '@/test/utilities'

import { PredicateRow, type PredicateRowProps } from './predicate-row'
import { buildPredicateRowProps } from './predicate-row.factory'

const scoped = (container: Container) => ({
  getRow() {
    return container.getByTestId('predicate-row')
  },
  getValueInput() {
    return container.getByLabelText('Value')
  },
  queryValueInput() {
    return container.queryByLabelText('Value')
  },
  /** The `between` operator's two value controls — it is the one rule whose
   * value is a `[min, max]` tuple rather than a scalar, so it has two inputs
   * where every other operator has the single `Value` one. */
  getLowerBoundInput() {
    return container.getByLabelText('Lower bound')
  },
  getUpperBoundInput() {
    return container.getByLabelText('Upper bound')
  },
  getRemoveButton() {
    return container.getByRole('button', { name: 'Remove rule' })
  },
  queryRemoveButton() {
    return container.queryByRole('button', { name: 'Remove rule' })
  },
  getFieldTrigger() {
    return container.getByRole('combobox', { name: 'Field' })
  },
  /** Every interactive control in the row, swept by role. Supplement only —
   * `getFormElements()` is the guarantee. */
  getInteractiveControls() {
    return interactiveControlsIn(container)
  },
  /** Every interactive element in the row, swept by DOM (`@/test/read-only`).
   * Empty is the point of the read-only view. */
  getFormElements() {
    return interactiveElementsIn(container.getByTestId('predicate-row'))
  },
})

/** Test page-object for `PredicateRow`. */
export const predicateRowPage = {
  render(overrides: Partial<PredicateRowProps> = {}) {
    render(<PredicateRow {...buildPredicateRowProps(overrides)} />)
  },

  within(container: Container = screen) {
    return scoped(container)
  },

  ...scoped(screen),
}
