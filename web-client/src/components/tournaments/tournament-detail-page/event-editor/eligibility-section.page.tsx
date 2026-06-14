import { render, screen, type Container } from '@/test/utilities'

import {
  EligibilitySection,
  type EligibilitySectionProps,
} from './eligibility-section'
import { buildEligibilitySectionProps } from './eligibility-section.factory'
import { predicateRowPage } from './eligibility-section/predicate-row.page'

const scoped = (container: Container) => ({
  getAddRuleButton() {
    return container.getByRole('button', { name: /Add (a )?rule/ })
  },
  queryRows() {
    return container.queryAllByTestId('predicate-row')
  },
  /** Reuse the predicate-row queries (scoped to the section). */
  ...predicateRowPage.within(container),
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
