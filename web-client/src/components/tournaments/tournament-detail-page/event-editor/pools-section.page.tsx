import { interactiveControlsIn, interactiveElementsIn } from '@/test/read-only'
import { render, screen, type Container } from '@/test/utilities'

import type { Pool } from '../../data/types'
import {
  buildPoolsSectionProps,
  type PoolsHarnessInputs,
} from './pools-section.factory'
import { PoolsHarness } from './pools-section.harness'
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
  /** Every Remove-pool button, in render order — to remove a specific card.
   *
   * `hidden: false` is NOT passed and must not be: a *disabled* button (the cut-draw
   * freeze, ADR-0786) is still in the accessibility tree with its name, and a query that
   * dropped it would report "no Remove button" for a state whose whole point is that the
   * button is there, visible, and dead. */
  getRemovePoolButtons() {
    return container.queryAllByRole('button', { name: 'Remove pool' })
  },
  /** The notice that says the pool SET is frozen because the draw is cut — and how to
   * get out of it. Absent when there is no draw, and absent for a viewer (who has no
   * add/remove affordance to explain and no draw to delete). */
  queryFrozenNotice() {
    return container.queryByTestId('pools-frozen-notice')
  },
  /** The live `pools` array in form state (via the probe), so a test can assert
   * that an add / edit / remove flowed through `useFieldArray`. */
  getPools(): Pool[] {
    const el = container.queryByTestId('pools-probe')
    return el ? (JSON.parse(el.textContent || '[]') as Pool[]) : []
  },
  /** The double-booking warning. Addressed by testid rather than by `role="alert"`:
   * the freeze notice is an `Alert` too, and an event can be both frozen and
   * double-booked — a role query would throw on exactly that overlap. */
  queryConflictAlert() {
    return container.queryByTestId('pools-conflict-alert')
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
  render(overrides: Partial<PoolsHarnessInputs> = {}) {
    render(<PoolsHarness {...buildPoolsSectionProps(overrides)} />)
  },

  within(container: Container = screen) {
    return scoped(container)
  },

  ...scoped(screen),
}
