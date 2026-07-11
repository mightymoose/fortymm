import { render, screen, type Container } from '@/test/utilities'

import { ReadOnlyValue, type ReadOnlyValueProps } from './read-only-value'
import { buildReadOnlyValueProps } from './read-only-value.factory'

/** The roles a form control would take in the accessibility tree. A read-only
 * surface must render none of them (ADR 0015). */
const INTERACTIVE_ROLES = ['textbox', 'combobox', 'switch', 'button'] as const

const scoped = (container: Container) => ({
  /** The rendered value, as text. Always present — an unset value renders an
   * em-dash rather than nothing. */
  getValue() {
    return container.getByTestId('tournament-read-only-value')
  },
  /** Every interactive control in scope, across the roles a form control could
   * claim. Empty is the whole point of the component. */
  getInteractiveControls() {
    return INTERACTIVE_ROLES.flatMap((role) => container.queryAllByRole(role))
  },
  /** Anything focusable — the tab-order escape hatch a plain `role` sweep would
   * miss (a `tabindex`, an anchor, a bare `<input>` with no accessible name). */
  getFocusableElements() {
    return container
      .getByTestId('tournament-read-only-value')
      .parentElement!.querySelectorAll(
        'input, select, textarea, button, a[href], [tabindex], [contenteditable="true"]',
      )
  },
})

/** Test page-object for `ReadOnlyValue` — the read-only counterpart to
 * `Field`'s control slot. Tests pass the value through `render({ children })`;
 * `getValue()` reads back what a viewer actually sees. */
export const readOnlyValuePage = {
  render(overrides: Partial<ReadOnlyValueProps> = {}) {
    render(<ReadOnlyValue {...buildReadOnlyValueProps(overrides)} />)
  },

  within(container: Container = screen) {
    return scoped(container)
  },

  ...scoped(screen),
}
