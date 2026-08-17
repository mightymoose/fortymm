import { interactiveElementsIn } from '@/test/read-only'
import { render, screen, type Container } from '@/test/utilities'

import { GroupStandingsTable, type GroupStandingsTableProps } from './group-standings-table'
import { buildGroupStandingsTableProps } from './group-standings-table.factory'
import { standingsTablePage } from './standings-table.page'

/** The accessible name a group's table carries — the wrapper's own wiring, written once. */
const tableName = (groupLabel: string) => `Standings for ${groupLabel}`

const scoped = (container: Container) => {
  // The table body IS `StandingsTable`'s, so its readers are `standingsTablePage`'s. Composed
  // rather than re-implemented: a row-slice-and-cell-index loop of our own would be a second
  // description of a table this file does not own, green while the shared one changed.
  const table = standingsTablePage.within(container)

  return {
    /** The group's table, by the group label in its accessible label — a draw shows several
     * side by side, so every "in *this* group" assertion narrows to it. */
    getTable(groupLabel: string) {
      return table.getTable(tableName(groupLabel))
    },

    /** The group's whole section, by group id — the scope the inert sweep narrows to. */
    getSection(groupId: string) {
      return container.getByTestId(`group-standings-${groupId}`)
    },

    /** The section as a **landmark named by its heading**: a `<section>` with
     * `aria-labelledby` is a `region`, so this resolves only while the `<h4>` naming the
     * group is still wired to the section around it. */
    getRegion(groupLabel: string) {
      return container.getByRole('region', { name: groupLabel })
    },

    /** The player names, top to bottom — the shared table's Player column, asked for by its
     * header and read through the group's accessible name. The ORDER is the claim: the
     * server's, untouched (ADR-0788). */
    getRowNames(groupLabel: string) {
      return table.getColumnUnder(tableName(groupLabel), 'Player')
    },

    /** Everything interactive in the group section — must be empty. Standings are a read
     * surface: a table of results has no controls of its own. */
    getControls(groupId: string) {
      return interactiveElementsIn(container.getByTestId(`group-standings-${groupId}`))
    },
  }
}

/** Test page-object for `GroupStandingsTable`. */
export const groupStandingsTablePage = {
  render(overrides: Partial<GroupStandingsTableProps> = {}) {
    render(<GroupStandingsTable {...buildGroupStandingsTableProps(overrides)} />)
  },

  within(container: Container = screen) {
    return scoped(container)
  },

  ...scoped(screen),
}
