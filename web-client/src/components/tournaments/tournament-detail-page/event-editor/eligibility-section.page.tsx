import { interactiveControlsIn, interactiveElementsIn } from '@/test/read-only'
import { render, screen, type Container } from '@/test/utilities'

import type { Predicate } from '../../data/types'
import {
  buildEligibilitySectionProps,
  type EligibilityHarnessInputs,
} from './eligibility-section.factory'
import { EligibilityHarness } from './eligibility-section.harness'
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
  /** Every Remove-rule button, in render order — to remove a specific row. */
  getRemoveRuleButtons() {
    return container.queryAllByRole('button', { name: 'Remove rule' })
  },
  /** The live `predicates` array in form state (via the probe), so a test can
   * assert that an add / edit / remove flowed through `useFieldArray`. */
  getPredicates(): Predicate[] {
    const el = container.queryByTestId('predicates-probe')
    return el ? (JSON.parse(el.textContent || '[]') as Predicate[]) : []
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
  render(overrides: Partial<EligibilityHarnessInputs> = {}) {
    render(<EligibilityHarness {...buildEligibilitySectionProps(overrides)} />)
  },

  within(container: Container = screen) {
    return scoped(container)
  },

  ...scoped(screen),
}
