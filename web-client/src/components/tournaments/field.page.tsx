import { render, screen, within, type Container } from '@/test/utilities'

import { Field, type FieldProps } from './field'
import { buildFieldProps } from './field.factory'
import { READ_ONLY_VALUE_TESTID } from './read-only-value.page'

const scoped = (container: Container) => ({
  /** The control wired to the field's label, by accessible name. */
  getControl(label: string) {
    return container.getByLabelText(new RegExp(label))
  },
  /** Absent in a read-only row: the row renders its value instead. */
  queryControl(label: string) {
    return container.queryByLabelText(new RegExp(label))
  },
  /** Hint / error text, when present. */
  queryHint(text: string) {
    return container.queryByText(text)
  },
  /** The label row's own text. The required asterisk is a `<span>` inside the
   * `<label>` with no separating space ("Name*"), so it is only visible in the
   * label's `textContent` — never as a text node of its own.
   *
   * `exact` matters where one label is a substring of another ("Name" vs "Venue
   * name"): the loose match would find both and throw. */
  getLabelText(label: string, { exact = false }: { exact?: boolean } = {}) {
    return container.getByText(label, { exact, selector: 'label' }).textContent
  },
  /** The value a read-only row renders in place of its control, found by the
   * row's label so the assertion survives a re-ordering of the rows. Composed by
   * every surface with `Field` rows, rather than re-derived in each. */
  getFieldValue(label: string) {
    const row = container
      .getByText(label, { exact: false, selector: 'label' })
      .closest('div')!
    return within(row).getByTestId(READ_ONLY_VALUE_TESTID)
  },
})

/** Test page-object for `Field` — the label/control/hint form row. */
export const fieldPage = {
  render(overrides: Partial<FieldProps> = {}) {
    render(<Field {...buildFieldProps(overrides)} />)
  },

  within(container: Container = screen) {
    return scoped(container)
  },

  ...scoped(screen),
}
