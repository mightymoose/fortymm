import { interactiveElementsIn } from '@/test/read-only'
import { render, screen, within, type Container } from '@/test/utilities'

import { PoolStandingsTable, type PoolStandingsTableProps } from './pool-standings-table'
import { buildPoolStandingsTableProps } from './pool-standings-table.factory'

const scoped = (container: Container) => {
  /** The pool's table, by the pool name in its accessible label — a draw shows several
   * side by side, so every "in *this* pool" assertion narrows to it. */
  const table = (poolName: string) =>
    container.getByRole('table', { name: `Standings for ${poolName}` })

  return {
    getTable: table,

    /** The pool's whole section, by pool id — the scope the inert sweep narrows to. */
    getSection(poolId: string) {
      return container.getByTestId(`pool-standings-${poolId}`)
    },

    /** One column header, by its ACCESSIBLE name — which is the FULL word a screen reader
     * hears (`Wins`), not the terse glyph on screen (`W`): the glyph span is
     * `aria-hidden`, so it is excluded from the accessible name, and the sr-only word is
     * what remains. `getByRole` here is the whole proof that the two channels are wired
     * right — it would not find a header whose only text was the bare glyph. */
    getColumnHeader(poolName: string, name: string) {
      return within(table(poolName)).getByRole('columnheader', { name })
    },

    /** The player names, top to bottom — the ORDER the table renders, which must be the
     * server's order untouched (ADR-0788). The Player cell is the second cell of each body
     * row. */
    getRowNames(poolName: string) {
      return within(table(poolName))
        .getAllByRole('row')
        // Drop the header row — `getAllByRole('row')` includes it.
        .slice(1)
        .map((row) => (within(row).getAllByRole('cell')[1].textContent ?? '').trim())
    },

    /** One row's cells as text, left to right (`['1', 'player.1', '2', '0', '+3', '4']`) —
     * for asserting the numbers, and the sign on the game difference. */
    getRowCells(entryId: string) {
      return within(container.getByTestId(`standing-row-${entryId}`))
        .getAllByRole('cell')
        .map((cell) => (cell.textContent ?? '').trim())
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
