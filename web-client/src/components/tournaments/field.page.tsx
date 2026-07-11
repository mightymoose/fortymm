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
  /** The label row's own text. The required asterisk is a `<span>` inside the
   * `<label>` with no separating space ("Name*"), so it is only visible in the
   * label's `textContent` — never as a text node of its own. */
  getLabelText(label: string) {
    return container.getByText(new RegExp(label), { selector: 'label' })
      .textContent
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
