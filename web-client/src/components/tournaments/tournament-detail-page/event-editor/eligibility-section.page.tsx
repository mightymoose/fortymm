import { interactiveControlsIn, interactiveElementsIn } from '@/test/read-only'
import { render, screen, type Container } from '@/test/utilities'

import {
  EligibilitySection,
  type EligibilitySectionProps,
} from './eligibility-section'
import { buildEligibilitySectionProps } from './eligibility-section.factory'
import { predicateRowPage } from './eligibility-section/predicate-row.page'

const scoped = (container: Container) => ({
  /** Reuse the predicate-row queries (scoped to the section). Spread first: the
   * section's own sweeps below are scoped to the *section* root, and must win
   * over the row-scoped ones of the same name. */
  ...predicateRowPage.within(container),

  getAddRuleButton() {
    return container.getByRole('button', { name: /Add (a )?rule/ })
  },
  /** Absent for a viewer: a mutating affordance is hidden, never disabled. */
  queryAddRuleButton() {
    return container.queryByRole('button', { name: /Add (a )?rule/ })
  },
  queryRows() {
    return container.queryAllByTestId('predicate-row')
  },
  /** The Field / Operator / Value column headers — form furniture that means
   * nothing without the controls beneath it. */
  queryColumnHeaders() {
    return container.queryByTestId('predicate-column-headers')
  },
  /** The "All N rules must match" footnote. */
  getFootnote() {
    return container.getByTestId('eligibility-footnote')
  },
  /** Every interactive control in the section, swept by role. Supplement only —
   * `getFormElements()` is the guarantee. */
  getInteractiveControls() {
    return interactiveControlsIn(container)
  },
  /** Every interactive element in the section, swept by DOM (`@/test/read-only`).
   * Empty is the point of the read-only view. */
  getFormElements() {
    return interactiveElementsIn(container.getByTestId('eligibility-section'))
  },
})

/** Test page-object for `EligibilitySection`. */
export const eligibilitySectionPage = {
  render(overrides: Partial<EligibilitySectionProps> = {}) {
    render(<EligibilitySection {...buildEligibilitySectionProps(overrides)} />)
  },

  within(container: Container = screen) {
    return scoped(container)
  },

  ...scoped(screen),
}
