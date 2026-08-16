import { interactiveControlsIn, interactiveElementsIn } from '@/test/read-only'
import { render, screen, within, type Container } from '@/test/utilities'

import type { PoolEntry } from '../../data/types'
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
  /** Every pool's name, **in the order the cards render** — the claim `Pool.position`
   * exists to make (`poolsInOrder`, `data/helpers`), and one no name-addressed accessor
   * can state: `getPoolNameInputs()` returns boxes without saying which pool each holds.
   *
   * Reads the box when there is one and the read-back text when there is not, so the
   * editor's order and the viewer's are the same assertion. */
  getPoolNames(): string[] {
    return container.queryAllByTestId('pool-card').map((card: HTMLElement) => {
      const box = within(card).queryByLabelText<HTMLInputElement>('Pool name')
      return box
        ? box.value
        : (within(card).getByTestId('pool-name').textContent ?? '').trim()
    })
  },
  /** Every pool's name box, in card order — the card-scoped `getNameInput()` throws
   * once there is more than one pool, and "which card is red?" is a question about the
   * whole list. */
  getPoolNameInputs() {
    return container.queryAllByLabelText('Pool name')
  },
  /** The red messages under the name boxes, in card order (`poolNameIssues`). Empty
   * until a save has been attempted — the editor hands the section nothing before
   * then. */
  getPoolNameErrors(): (string | null)[] {
    return container
      .queryAllByTestId('pool-name-error')
      .map((node: HTMLElement) => node.textContent)
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
   * that an add / edit / remove flowed through `useFieldArray`.
   *
   * `PoolEntry[]`, not `Pool[]`: what the form holds is the **diff** the save
   * serializes (ADR 20260801) — entries that either cite the id the server minted
   * (`kind: 'kept'`) or carry none at all (`kind: 'added'`). Read off the probe's JSON,
   * so `'id' in entry` is a real question about the payload rather than about a
   * TypeScript type. */
  getPools(): PoolEntry[] {
    const el = container.queryByTestId('pools-probe')
    return el ? (JSON.parse(el.textContent || '[]') as PoolEntry[]) : []
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
