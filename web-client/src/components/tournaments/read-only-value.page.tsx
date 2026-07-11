import { interactiveControlsIn, interactiveElementsIn } from '@/test/read-only'
import { render, screen, type Container } from '@/test/utilities'

import { ReadOnlyValue, type ReadOnlyValueProps } from './read-only-value'
import { buildReadOnlyValueProps } from './read-only-value.factory'

/** The testid `ReadOnlyValue` stamps on its rendering. Every page object that
 * reads a value back goes through this constant rather than re-typing it. */
export const READ_ONLY_VALUE_TESTID = 'tournament-read-only-value'

const scoped = (container: Container) => ({
  /** The rendered value, as text. Always present — an unset value renders an
   * em-dash rather than nothing. */
  getValue() {
    return container.getByTestId(READ_ONLY_VALUE_TESTID)
  },
  /** Every interactive control in scope, swept by role. Empty is the whole point
   * of the component. Supplement only — `getFormElements()` is the guarantee. */
  getInteractiveControls() {
    return interactiveControlsIn(container)
  },
  /** Every interactive element in scope, swept by DOM (`@/test/read-only`) — the
   * tab-order escape hatch a role sweep would miss (a `tabindex`, an anchor, a
   * bare `<input>` with no accessible name). */
  getFormElements() {
    return interactiveElementsIn(
      container.getByTestId(READ_ONLY_VALUE_TESTID).parentElement!,
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
