import { render, screen, type Container } from '@/test/utilities'

import { PredicateRow, type PredicateRowProps } from './predicate-row'
import { buildPredicateRowProps } from './predicate-row.factory'

/** The roles a form control would take in the accessibility tree. A read-only
 * row must render none of them (ADR 0015). */
const INTERACTIVE_ROLES = ['textbox', 'combobox', 'switch', 'button'] as const

/** The role sweep alone under-proves this row: its value control is a
 * `type="number"` input (a `spinbutton`, not a `textbox`) and its field/operator
 * pickers are `OptionSelect`s. This catches the element itself, whatever role it
 * claims — the DOM sweep ADR 0015 rule 6 calls for. */
const FORM_ELEMENTS =
  'input, select, textarea, button, [role="switch"], [role="radio"], [tabindex], [contenteditable]'

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
  getRemoveButton() {
    return container.getByRole('button', { name: 'Remove rule' })
  },
  queryRemoveButton() {
    return container.queryByRole('button', { name: 'Remove rule' })
  },
  getFieldTrigger() {
    return container.getByRole('combobox', { name: 'Field' })
  },
  /** Every interactive control in the row. Empty is the point of the read-only
   * view. */
  getInteractiveControls() {
    return INTERACTIVE_ROLES.flatMap((role) => container.queryAllByRole(role))
  },
  /** Every form element in the row, by tag/widget role rather than by the four
   * canonical roles — the escape hatch the role sweep misses. */
  getFormElements() {
    return container.getByTestId('predicate-row').querySelectorAll(FORM_ELEMENTS)
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
