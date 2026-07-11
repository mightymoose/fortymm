import { render, screen, type Container } from '@/test/utilities'

import {
  EligibilitySection,
  type EligibilitySectionProps,
} from './eligibility-section'
import { buildEligibilitySectionProps } from './eligibility-section.factory'
import { predicateRowPage } from './eligibility-section/predicate-row.page'

/** The roles a form control would take in the accessibility tree. A read-only
 * surface must render none of them (ADR 0015). */
const INTERACTIVE_ROLES = ['textbox', 'combobox', 'switch', 'button'] as const

/** The role sweep alone under-proves this section: a rule row's value control is
 * a `type="number"` input, which is a `spinbutton` rather than a `textbox`, so a
 * live rule builder would sail straight through it. This catches the element
 * itself, whatever role it claims (ADR 0015, rule 6). */
const FORM_ELEMENTS =
  'input, select, textarea, button, [role="switch"], [role="radio"], [tabindex], [contenteditable]'

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
  /** Every interactive control in the section. Empty is the point of the
   * read-only view. */
  getInteractiveControls() {
    return INTERACTIVE_ROLES.flatMap((role) => container.queryAllByRole(role))
  },
  /** Every form element in the section, by tag/widget role rather than by the
   * four canonical roles — the escape hatch the role sweep misses. */
  getFormElements() {
    return container
      .getByTestId('eligibility-section')
      .querySelectorAll(FORM_ELEMENTS)
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
