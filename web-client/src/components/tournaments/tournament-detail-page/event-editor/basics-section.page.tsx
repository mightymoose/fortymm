import { interactiveControlsIn, interactiveElementsIn } from '@/test/read-only'
import { render, screen, type Container } from '@/test/utilities'

import { fieldPage } from '../../field.page'
import { BasicsSection, type BasicsSectionProps } from './basics-section'
import { buildBasicsSectionProps } from './basics-section.factory'

const scoped = (container: Container) => ({
  /** Reuse the `Field` row queries (label text, the read-only value under a
   * label) — this section is nothing but `Field` rows. */
  ...fieldPage.within(container),

  getNameInput() {
    return container.getByLabelText(/Event name/)
  },
  getPlayerLimitInput() {
    return container.getByLabelText(/Player limit/)
  },
  getEntryFeeInput() {
    return container.getByLabelText(/Entry fee/)
  },
  /** The red message under a field — the `Field` row's `hint`, rendered as an error.
   * Queried by its TEXT because that is what the organizer reads; a test that asked
   * for "the hint node" would pass on a message rendered in the wrong colour under
   * the wrong control. */
  queryFieldError(message: string) {
    return container.queryByText(message)
  },
  getFormatTrigger() {
    return container.getByRole('combobox', { name: 'Format' })
  },
  /** The "Hard cap…" helper text under Player limit — form furniture, and so
   * absent from the read-only view (ADR 0015). */
  queryPlayerLimitHint() {
    return container.queryByText(/Hard cap\. Waitlist opens past this\./)
  },
  /** Every interactive control in the section, swept by role. Supplement only —
   * `getFormElements()` is the guarantee. */
  getInteractiveControls() {
    return interactiveControlsIn(container)
  },
  /** Every interactive element in the section, swept by DOM (`@/test/read-only`).
   * Empty is the point of the read-only view. */
  getFormElements() {
    return interactiveElementsIn(container.getByTestId('basics-section'))
  },
})

/** Test page-object for `BasicsSection`. */
export const basicsSectionPage = {
  render(overrides: Partial<BasicsSectionProps> = {}) {
    render(<BasicsSection {...buildBasicsSectionProps(overrides)} />)
  },

  within(container: Container = screen) {
    return scoped(container)
  },

  ...scoped(screen),
}
