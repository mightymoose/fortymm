import { render, screen, type Container } from '@/test/utilities'

import { FormChips, type FormChipsProps } from './form-chips'
import { buildFormChipsProps } from './form-chips.factory'

const scoped = (container: Container) => ({
  /** The run of form chips, found by the label that names its results. */
  getForm() {
    return container.getByLabelText(/^Last \d+: /)
  },
  queryForm() {
    return container.queryByLabelText(/^Last \d+: /)
  },
  /** The individual result chips, in render order (newest first). */
  getChips() {
    return Array.from(
      scoped(container).getForm().querySelectorAll('.player-profile__form-chip'),
    ) as HTMLElement[]
  },
})

/**
 * Test page-object for `FormChips` — the run of W/L results in the hero. The
 * chips themselves are `aria-hidden` (the label speaks for them), so tests read
 * the chip *count* and the label, which is what a reader gets.
 */
export const formChipsPage = {
  render(overrides: Partial<FormChipsProps> = {}) {
    const props = buildFormChipsProps(overrides)
    render(<FormChips {...props} />)
  },

  within(container: Container = screen) {
    return scoped(container)
  },

  ...scoped(screen),
}
