import { render, screen, within, type Container } from '@/test/utilities'

import { StandingsTable, type StandingsTableProps } from './standings-table'
import { buildStandingsTableProps } from './standings-table.factory'

const scoped = (container: Container) => ({
  /** The table itself, by its accessible name — the one thing the caller supplies, so a
   * table found this way is a table whose `aria-label` was really wired through. */
  getTable(ariaLabel: string) {
    return container.getByRole('table', { name: ariaLabel })
  },

  /** Every column header's visible glyph, left to right — the terse on-screen row. */
  getHeaderGlyphs(ariaLabel: string) {
    return within(this.getTable(ariaLabel))
      .getAllByRole('columnheader')
      .map((h) => (h.textContent ?? '').trim())
  },

  /** One column of body cells, top to bottom, by its **index** in the header order
   * (`#`, Player, W, L, Diff, GW). */
  getColumn(ariaLabel: string, index: number) {
    return within(this.getTable(ariaLabel))
      .getAllByRole('row')
      .slice(1)
      .map((row) => (within(row).getAllByRole('cell')[index].textContent ?? '').trim())
  },

  /** One entry's row, by the entry id it is keyed on — for scoping a per-row assertion. */
  getRow(entryId: string) {
    return container.getByTestId(`standing-row-${entryId}`)
  },
  queryRow(entryId: string) {
    return container.queryByTestId(`standing-row-${entryId}`)
  },
})

/** Test page-object for `StandingsTable` — the table body shared by the pooled and the
 * pool-less standings blocks. */
export const standingsTablePage = {
  render(overrides: Partial<StandingsTableProps> = {}) {
    render(<StandingsTable {...buildStandingsTableProps(overrides)} />)
  },

  within(container: Container = screen) {
    return scoped(container)
  },

  ...scoped(screen),
}
