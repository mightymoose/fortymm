import { interactiveControlsIn, interactiveElementsIn } from '@/test/read-only'
import { render, screen, type Container } from '@/test/utilities'

import { PoolsSection, type PoolsSectionProps } from './pools-section'
import { buildPoolsSectionProps } from './pools-section.factory'
import { poolCardPage } from './pools-section/pool-card.page'

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
  /** Every interactive control in the section, swept by role. Supplement only —
   * `getFormElements()` is the guarantee. */
  getInteractiveControls() {
    return interactiveControlsIn(container)
  },
  /** Every interactive element in the section, swept by DOM (`@/test/read-only`).
   * Empty is the point of the read-only view. */
  getFormElements() {
    return interactiveElementsIn(container.getByTestId('pools-section'))
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
