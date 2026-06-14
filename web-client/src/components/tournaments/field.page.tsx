import { render, screen, type Container } from '@/test/utilities'

import { Field, type FieldProps } from './field'
import { buildFieldProps } from './field.factory'

const scoped = (container: Container) => ({
  /** The control wired to the field's label, by accessible name. */
  getControl(label: string) {
    return container.getByLabelText(new RegExp(label))
  },
  /** Hint / error text, when present. */
  queryHint(text: string) {
    return container.queryByText(text)
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
