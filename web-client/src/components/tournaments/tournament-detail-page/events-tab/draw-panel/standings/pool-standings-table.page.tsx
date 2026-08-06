import { interactiveElementsIn } from '@/test/read-only'
import { render, screen, type Container } from '@/test/utilities'

import { PoolStandingsTable, type PoolStandingsTableProps } from './pool-standings-table'
import { buildPoolStandingsTableProps } from './pool-standings-table.factory'
import { PLAYER_COLUMN, standingsTablePage } from './standings-table.page'

/** The accessible name a pool's table carries — the wrapper's own wiring, written once. */
const tableName = (poolName: string) => `Standings for ${poolName}`

const scoped = (container: Container) => {
  // The table body IS `StandingsTable`'s, so its readers are `standingsTablePage`'s. Composed
  // rather than re-implemented: a row-slice-and-cell-index loop of our own would be a second
  // description of a table this file does not own, green while the shared one changed.
  const table = standingsTablePage.within(container)

  return {
    /** The pool's table, by the pool name in its accessible label — a draw shows several
     * side by side, so every "in *this* pool" assertion narrows to it. */
    getTable(poolName: string) {
      return table.getTable(tableName(poolName))
    },

    /** The pool's whole section, by pool id — the scope the inert sweep narrows to. */
    getSection(poolId: string) {
      return container.getByTestId(`pool-standings-${poolId}`)
    },

    /** The section as a **landmark named by its heading**: a `<section>` with
     * `aria-labelledby` is a `region`, so this resolves only while the `<h4>` naming the
     * pool is still wired to the section around it. */
    getRegion(poolName: string) {
      return container.getByRole('region', { name: poolName })
    },

    /** The player names, top to bottom — the shared table's Player column, read through the
     * pool's accessible name. The ORDER is the claim: the server's, untouched (ADR-0788). */
    getRowNames(poolName: string) {
      return table.getColumn(tableName(poolName), PLAYER_COLUMN)
    },

    /** Everything interactive in the pool section — must be empty. Standings are a read
     * surface: a table of results has no controls of its own. */
    getControls(poolId: string) {
      return interactiveElementsIn(container.getByTestId(`pool-standings-${poolId}`))
    },
  }
}

/** Test page-object for `PoolStandingsTable`. */
export const poolStandingsTablePage = {
  render(overrides: Partial<PoolStandingsTableProps> = {}) {
    render(<PoolStandingsTable {...buildPoolStandingsTableProps(overrides)} />)
  },

  within(container: Container = screen) {
    return scoped(container)
  },

  ...scoped(screen),
}
