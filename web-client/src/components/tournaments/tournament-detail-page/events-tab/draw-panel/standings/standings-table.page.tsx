import { render, screen, within, type Container } from '@/test/utilities'

import { StandingsTable, type StandingsTableProps } from './standings-table'
import { buildStandingsTableProps } from './standings-table.factory'

/** The **Player** column's index in the header order (`#`, Player, W, L, Diff, GW) — the
 * one column every caller reads by name rather than by number, since "who is in this table,
 * in what order" is the assertion each of them makes. Stated once so a column inserted to
 * its left is one edit, not four. */
export const PLAYER_COLUMN = 1

const scoped = (container: Container) => ({
  /** The table itself, by its accessible name — the one thing the caller supplies, so a
   * table found this way is a table whose `aria-label` was really wired through. */
  getTable(ariaLabel: string) {
    return container.getByRole('table', { name: ariaLabel })
  },

  /** One column header, by its **accessible name** — the FULL word a screen reader hears
   * (`Wins`), not the terse glyph on screen (`W`). The glyph span is `aria-hidden`, so it is
   * excluded from the accessible name and the `sr-only` word is what remains.
   *
   * This is the only reader that proves that wiring: `getHeaderGlyphs` below reads
   * `textContent`, which concatenates both spans and ignores `aria-hidden` entirely, so it
   * stays green on a header whose glyph leaked into the name a reader hears. */
  getColumnHeader(ariaLabel: string, name: string) {
    return within(this.getTable(ariaLabel)).getByRole('columnheader', { name })
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
