import { render, screen, within, type Container } from '@/test/utilities'

import { StandingsTable } from './standings-table'
import {
  buildPoolStandingsTableProps,
  buildSwissStandingsTableProps,
  type PoolOverrides,
  type SwissOverrides,
} from './standings-table.factory'

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

  /**
   * One column of body cells, top to bottom, addressed by its **header's full word**
   * ("Player", "Buchholz", "Wins") rather than by index.
   *
   * The index is exactly what a Buchholz column changes — a pool table runs `#`, Player, W,
   * L, Diff, GW and a swiss table inserts **Buc** between L and Diff — so an index-addressed
   * assertion would move under this feature and, worse, could silently start reading the
   * neighbour it displaced. Asking by header ties the cells to the heading above them, which
   * is also the claim a screen-reader user relies on. It is the **only** column reader here
   * for that reason: an index-taking one left beside it is an index-taking one someone
   * reaches for.
   */
  getColumnUnder(ariaLabel: string, header: string) {
    const table = within(this.getTable(ariaLabel))
    const index = table
      .getAllByRole('columnheader')
      .findIndex((h) => (h.textContent ?? '').includes(header))
    if (index === -1) {
      throw new Error(
        `No column headed "${header}" in the table "${ariaLabel}". Headers: ${table
          .getAllByRole('columnheader')
          .map((h) => (h.textContent ?? '').trim())
          .join(', ')}`,
      )
    }
    return table
      .getAllByRole('row')
      .slice(1)
      .map((row) => (within(row).getAllByRole('cell')[index].textContent ?? '').trim())
  },

  /** Whether a column with this header exists at all — for the claim that a **pool** table
   * has no Buchholz column, which is half of what `format` decides. */
  hasColumn(ariaLabel: string, header: string) {
    return within(this.getTable(ariaLabel))
      .getAllByRole('columnheader')
      .some((h) => (h.textContent ?? '').includes(header))
  },

  /** How many body cells a row holds — the guard that the header and the cells agree about
   * how many columns there are. A table whose header grew a column its rows did not is not
   * a table any assertion above would catch. */
  getCellCounts(ariaLabel: string) {
    return within(this.getTable(ariaLabel))
      .getAllByRole('row')
      .slice(1)
      .map((row) => within(row).getAllByRole('cell').length)
  },

  /** One entry's row, by the entry id it is keyed on — for scoping a per-row assertion. */
  getRow(entryId: string) {
    return container.getByTestId(`standing-row-${entryId}`)
  },
  queryRow(entryId: string) {
    return container.queryByTestId(`standing-row-${entryId}`)
  },
})

/**
 * Test page-object for `StandingsTable` — the table shared by the pooled and the pool-less
 * standings blocks.
 *
 * **Two renders, one per arm of `StandingsTableRows`**, rather than one `render` taking a
 * `format`: the tag decides which columns exist *and* which row type is legal, so a single
 * entry point would have to take a half-typed union and would let a test ask for a swiss
 * table over pool rows — the exact state the component's props were shaped to forbid.
 */
export const standingsTablePage = {
  /** A **pool** table: no Buchholz column. */
  renderPool(overrides: PoolOverrides = {}) {
    render(<StandingsTable {...buildPoolStandingsTableProps(overrides)} />)
  },

  /** A **swiss** table: the same columns plus Buchholz. */
  renderSwiss(overrides: SwissOverrides = {}) {
    render(<StandingsTable {...buildSwissStandingsTableProps(overrides)} />)
  },

  within(container: Container = screen) {
    return scoped(container)
  },

  ...scoped(screen),
}
