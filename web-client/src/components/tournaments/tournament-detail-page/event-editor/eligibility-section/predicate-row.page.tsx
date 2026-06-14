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
  getRemoveButton() {
    return container.getByRole('button', { name: 'Remove rule' })
  },
  getFieldTrigger() {
    return container.getByRole('combobox', { name: 'Field' })
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
