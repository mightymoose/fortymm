import { interactiveElementsIn } from '@/test/read-only'
import { render, screen, within, type Container } from '@/test/utilities'

import { PoolDraw, type PoolDrawProps } from './pool-draw'
import { buildPoolDrawProps } from './pool-draw.factory'
import { roundListPage } from './round-list.page'
import { fixtureLineTexts } from './round-list/fixture-line.page'

const scoped = (container: Container) => ({
  /** The pool's whole section, by pool id — the scope every "in *this* pool" assertion
   * narrows to, since a draw renders several of these side by side. */
  getPool(poolId: string) {
    return container.getByTestId(`pool-draw-${poolId}`)
  },
  queryPool(poolId: string) {
    return container.queryByTestId(`pool-draw-${poolId}`)
  },
  /** The pool's heading — its name, as the event's `pools` names it. */
  getPoolHeading(poolName: string) {
    return container.getByRole('heading', { name: poolName })
  },
  /** The pool's entrants, in the order they render (draw order: seed, then
   * registration). Names, not ids — a chip list of uuids would pass a "renders the
   * roster" assertion and tell a director nothing. */
  getPoolEntrants(poolName: string) {
    return within(container.getByRole('list', { name: `Entrants in ${poolName}` }))
      .getAllByRole('listitem')
      .map((li) => (li.textContent ?? '').trim())
  },
  /** Every fixture line inside one pool, in DOM order — the sequence *is* the draw. */
  getPoolLines(poolId: string) {
    return fixtureLineTexts(container.getByTestId(`pool-draw-${poolId}`))
  },
  /** Everything interactive in the pool. Must always be empty: a fixture is a planned
   * pairing, not a match, and the pool scaffold has no controls of its own — the draw's
   * actions live in the panel's header. */
  getPoolControls(poolId: string) {
    return interactiveElementsIn(container.getByTestId(`pool-draw-${poolId}`))
  },
  // The round accessors (`getRoundLines`, `getRoundNames`) come from the round list.
  ...roundListPage.within(container),
})

/** Test page-object for `PoolDraw`. */
export const poolDrawPage = {
  render(overrides: Partial<PoolDrawProps> = {}) {
    render(<PoolDraw {...buildPoolDrawProps(overrides)} />)
  },

  within(container: Container = screen) {
    return scoped(container)
  },

  ...scoped(screen),
}
