import { render, screen, type Container } from '@/test/utilities'

import { PoolsSection, type PoolsSectionProps } from './pools-section'
import { buildPoolsSectionProps } from './pools-section.factory'
import { poolCardPage } from './pools-section/pool-card.page'

/** The roles a form control would take in the accessibility tree. A read-only
 * section must render none of them (ADR 0015). */
const INTERACTIVE_ROLES = ['textbox', 'combobox', 'switch', 'button'] as const

/** The role sweep alone under-proves this section: each pool card's window is
 * three `type="date"` / `type="time"` inputs, which have **no ARIA role at all**.
 * This catches the element itself, whatever role it claims (ADR 0015, rule 6). */
const FORM_ELEMENTS =
  'input, select, textarea, button, [role="switch"], [role="radio"], [tabindex], [contenteditable]'

const scoped = (container: Container) => ({
  /** Reuse the pool-card queries (scoped to the section). Spread first: the
   * section's own sweeps below are scoped to the *section* root, and must win
   * over the card-scoped ones of the same name — a card-scoped sweep throws once
   * there is more than one pool. */
  ...poolCardPage.within(container),

  getAddPoolButton() {
    return container.getByRole('button', { name: /Add (first )?pool/ })
  },
  /** Absent for a viewer: a mutating affordance is hidden, never disabled. */
  queryAddPoolButton() {
    return container.queryByRole('button', { name: /Add (first )?pool/ })
  },
  queryPoolCards() {
    return container.queryAllByTestId('pool-card')
  },
  queryConflictAlert() {
    return container.queryByRole('alert')
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
      .getByTestId('pools-section')
      .querySelectorAll(FORM_ELEMENTS)
  },
})

/** Test page-object for `PoolsSection`. */
export const poolsSectionPage = {
  render(overrides: Partial<PoolsSectionProps> = {}) {
    render(<PoolsSection {...buildPoolsSectionProps(overrides)} />)
  },

  within(container: Container = screen) {
    return scoped(container)
  },

  ...scoped(screen),
}
